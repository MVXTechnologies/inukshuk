import { XMLParser } from 'fast-xml-parser';

import type { TrackPoint } from '@core/models';

/**
 * Garmin Training Center XML (TCX) reader — pure TypeScript. Covers
 * `<Activities>` (Garmin/Strava activity exports) and `<Courses>` (planned
 * routes). Trackpoints without a `<Position>` (indoor laps, HR-only samples)
 * are skipped.
 *
 * Segments: Garmin writes one `<Lap>` per auto-lap and starts a fresh
 * `<Track>` inside the lap after a pause, so a Track that is not the first of
 * its Lap opens a new segment. Lap boundaries themselves are not pauses.
 */

export interface TcxActivity {
  points: TrackPoint[];
  segmentStarts: number[];
  /** Normalized sport key from `Sport="…"` (`running`, `cycling`, `other`). */
  sport?: string;
  /** Epoch ms of the activity `<Id>` (its start), if parseable. */
  startTime?: number;
  /** Course `<Name>` (activities carry none). */
  name?: string;
}

export class TcxParseError extends Error {
  constructor(message: string) {
    super(`TCX: ${message}`);
    this.name = 'TcxParseError';
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  removeNSPrefix: true,
  isArray: (name) =>
    name === 'Activity' ||
    name === 'Course' ||
    name === 'Lap' ||
    name === 'Track' ||
    name === 'Trackpoint',
});

type AnyRecord = Record<string, unknown>;

const asArray = <T>(v: unknown): T[] => {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? (v as T[]) : [v as T];
};

const textOf = (node: unknown): string | undefined => {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (node && typeof node === 'object' && '#text' in node) {
    const t = (node as AnyRecord)['#text'];
    return t === undefined || t === null ? undefined : String(t);
  }
  return undefined;
};

const toNum = (node: unknown): number | undefined => {
  const t = textOf(node);
  if (t === undefined || t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
};

const toTime = (node: unknown): number | undefined => {
  const t = textOf(node);
  if (!t) return undefined;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? undefined : ms;
};

const SPORTS: Record<string, string> = { running: 'running', biking: 'cycling', other: 'other' };

/** Is this text a TCX document (cheap sniff, no full parse)? */
export function looksLikeTcx(text: string): boolean {
  return /<([A-Za-z0-9_]+:)?TrainingCenterDatabase[\s>]/.test(text.slice(0, 4096));
}

function findSpeed(ext: unknown): number | undefined {
  if (!ext || typeof ext !== 'object') return undefined;
  for (const [k, v] of Object.entries(ext as AnyRecord)) {
    if (k === 'Speed') return toNum(v);
    const nested = findSpeed(v);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function parseTrackpoint(raw: AnyRecord): TrackPoint | undefined {
  const pos = raw['Position'] as AnyRecord | undefined;
  if (!pos || typeof pos !== 'object') return undefined;
  const latitude = toNum(pos['LatitudeDegrees']);
  const longitude = toNum(pos['LongitudeDegrees']);
  if (
    latitude === undefined ||
    longitude === undefined ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return undefined;
  }
  const time = toTime(raw['Time']);
  const point: TrackPoint = { latitude, longitude, time: time ?? 0, hasTime: time !== undefined };
  const altitude = toNum(raw['AltitudeMeters']);
  if (altitude !== undefined) point.altitude = altitude;
  const hrNode = raw['HeartRateBpm'];
  const hr = toNum(hrNode && typeof hrNode === 'object' ? (hrNode as AnyRecord)['Value'] : hrNode);
  if (hr !== undefined && hr > 0) point.heartRateBpm = hr;
  const speed = findSpeed(raw['Extensions']);
  if (speed !== undefined && speed >= 0) point.speed = speed;
  return point;
}

/** Append a Track's points, opening a segment when `newSegment` and points exist. */
function addTrack(
  track: AnyRecord,
  newSegment: boolean,
  points: TrackPoint[],
  segmentStarts: number[],
): void {
  const before = points.length;
  for (const tp of asArray<AnyRecord>(track['Trackpoint'])) {
    const p = parseTrackpoint(tp);
    if (p) points.push(p);
  }
  if (newSegment && before > 0 && points.length > before) segmentStarts.push(before);
}

/**
 * Parse a TCX document into one activity per `<Activity>` / `<Course>` that
 * has positioned trackpoints. Throws {@link TcxParseError} when the input is
 * not TCX at all.
 */
export function parseTcx(xml: string): TcxActivity[] {
  let parsed: AnyRecord;
  try {
    parsed = parser.parse(xml) as AnyRecord;
  } catch (err) {
    throw new TcxParseError(`not valid XML: ${err instanceof Error ? err.message : String(err)}`);
  }
  const root = parsed['TrainingCenterDatabase'] as AnyRecord | undefined;
  if (!root || typeof root !== 'object') {
    throw new TcxParseError('missing <TrainingCenterDatabase> root');
  }

  const out: TcxActivity[] = [];
  const activities = (root['Activities'] as AnyRecord | undefined)?.['Activity'];
  for (const act of asArray<AnyRecord>(activities)) {
    const points: TrackPoint[] = [];
    const segmentStarts: number[] = [];
    for (const lap of asArray<AnyRecord>(act['Lap'])) {
      asArray<AnyRecord>(lap['Track']).forEach((track, i) =>
        addTrack(track, i > 0, points, segmentStarts),
      );
    }
    if (points.length === 0) continue;
    const activity: TcxActivity = { points, segmentStarts };
    const sport = textOf(act['@_Sport'])?.toLowerCase();
    if (sport) activity.sport = SPORTS[sport] ?? sport;
    const start = toTime(act['Id']);
    if (start !== undefined) activity.startTime = start;
    out.push(activity);
  }

  const courses = (root['Courses'] as AnyRecord | undefined)?.['Course'];
  for (const course of asArray<AnyRecord>(courses)) {
    const points: TrackPoint[] = [];
    const segmentStarts: number[] = [];
    asArray<AnyRecord>(course['Track']).forEach((track, i) =>
      addTrack(track, i > 0, points, segmentStarts),
    );
    if (points.length === 0) continue;
    const activity: TcxActivity = { points, segmentStarts };
    const name = textOf(course['Name'])?.trim();
    if (name) activity.name = name;
    out.push(activity);
  }
  return out;
}
