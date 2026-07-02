import { XMLBuilder, XMLParser } from 'fast-xml-parser';

import type { TrackPoint } from '@core/models';

/**
 * GPX 1.1 read/write — pure TypeScript, no platform dependencies. Tolerant
 * parsing (missing ele/time are fine) and round-trip-safe serialization.
 */

export interface GpxMetadata {
  name?: string;
  description?: string;
  /** Epoch milliseconds of the document's <metadata><time>. */
  time?: number;
  creator?: string;
}

export interface GpxWaypoint {
  latitude: number;
  longitude: number;
  name?: string;
  description?: string;
  symbol?: string;
  /** Epoch milliseconds of the waypoint's <time>, if present. */
  time?: number;
}

export interface GpxDocument {
  metadata: GpxMetadata;
  /** All track/route/waypoint points, flattened in document order. */
  points: TrackPoint[];
  /** Standalone <wpt> markers, preserved with their labels. */
  waypoints: GpxWaypoint[];
  /** True when `points` came from <trk>/<rte> (not the <wpt> fallback). */
  hasTrackOrRoutePoints: boolean;
}

const GPX_NS = 'http://www.topografix.com/GPX/1/1';
const ATTR_PREFIX = '@_';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ATTR_PREFIX,
  parseAttributeValue: false, // we parse lat/lon ourselves to control precision
  parseTagValue: false,
  trimValues: true,
  // Force these to always be arrays so single-vs-many is uniform.
  isArray: (name, _jpath) =>
    name === 'trk' ||
    name === 'trkseg' ||
    name === 'trkpt' ||
    name === 'rte' ||
    name === 'rtept' ||
    name === 'wpt',
});

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: ATTR_PREFIX,
  format: true,
  suppressEmptyNode: true,
});

const toNum = (v: unknown): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const round = (n: number, decimals: number): number => {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
};

/** Read the text content of a tag that fast-xml-parser may give as string or object. */
const textOf = (node: unknown): string | undefined => {
  if (node === undefined || node === null) return undefined;
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (typeof node === 'object' && '#text' in (node as Record<string, unknown>)) {
    const t = (node as Record<string, unknown>)['#text'];
    return t === undefined || t === null ? undefined : String(t);
  }
  return undefined;
};

const isoToEpochMs = (iso: string | undefined): number | undefined => {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
};

const epochMsToIso = (ms: number): string => new Date(ms).toISOString();

type AnyRecord = Record<string, unknown>;

const asArray = <T>(v: unknown): T[] => {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? (v as T[]) : [v as T];
};

/** Find the first `*:speed` (or `speed`) key anywhere in a nested extensions object. */
const findSpeedDeep = (obj: AnyRecord): number | undefined => {
  for (const [k, v] of Object.entries(obj)) {
    if (/(^|:)speed$/i.test(k)) {
      const n = toNum(textOf(v));
      if (n !== undefined) return n;
    }
    if (v && typeof v === 'object') {
      const n = findSpeedDeep(v as AnyRecord);
      if (n !== undefined) return n;
    }
  }
  return undefined;
};

/**
 * Ground speed in m/s from a trkpt: either a direct `<speed>` child (common in
 * many loggers) or a `gpxtpx:speed` inside `<extensions>` (Garmin TrackPointExtension).
 */
const extractSpeed = (raw: AnyRecord): number | undefined => {
  const direct = toNum(textOf(raw['speed']));
  if (direct !== undefined) return direct;
  const ext = raw['extensions'];
  return ext && typeof ext === 'object' ? findSpeedDeep(ext as AnyRecord) : undefined;
};

const parsePoint = (raw: AnyRecord): TrackPoint | undefined => {
  const lat = toNum(raw[`${ATTR_PREFIX}lat`]);
  const lon = toNum(raw[`${ATTR_PREFIX}lon`]);
  if (lat === undefined || lon === undefined) return undefined;
  const altitude = toNum(textOf(raw['ele']));
  const time = isoToEpochMs(textOf(raw['time']));
  const speed = extractSpeed(raw);
  const point: TrackPoint = {
    latitude: lat,
    longitude: lon,
    // GPX has no time on every fix; default to 0 so downstream ordering is
    // stable but callers can detect "no time" via metadata if needed.
    time: time ?? 0,
  };
  if (altitude !== undefined) point.altitude = altitude;
  if (speed !== undefined && speed >= 0) point.speed = speed;
  return point;
};

const parseWaypoint = (raw: AnyRecord): GpxWaypoint | undefined => {
  const lat = toNum(raw[`${ATTR_PREFIX}lat`]);
  const lon = toNum(raw[`${ATTR_PREFIX}lon`]);
  if (lat === undefined || lon === undefined) return undefined;
  const wpt: GpxWaypoint = { latitude: lat, longitude: lon };
  const name = textOf(raw['name']);
  if (name !== undefined) wpt.name = name;
  const desc = textOf(raw['desc']) ?? textOf(raw['description']);
  if (desc !== undefined) wpt.description = desc;
  const sym = textOf(raw['sym']);
  if (sym !== undefined) wpt.symbol = sym;
  const time = isoToEpochMs(textOf(raw['time']));
  if (time !== undefined) wpt.time = time;
  return wpt;
};

/**
 * Parse a GPX XML string into a flattened document. Tolerant of missing
 * ele/time. Throws only when the input has no recognizable <gpx> root.
 */
export function parseGpx(xml: string): GpxDocument {
  if (typeof xml !== 'string' || xml.trim() === '') {
    throw new Error('parseGpx: empty input');
  }

  let parsed: AnyRecord;
  try {
    parsed = parser.parse(xml) as AnyRecord;
  } catch (err) {
    throw new Error(`parseGpx: not valid XML: ${err instanceof Error ? err.message : String(err)}`);
  }

  const gpx = parsed['gpx'] as AnyRecord | undefined;
  if (!gpx || typeof gpx !== 'object') {
    throw new Error('parseGpx: missing <gpx> root element');
  }

  const metadata: GpxMetadata = {};
  const creator = textOf(gpx[`${ATTR_PREFIX}creator`]);
  if (creator !== undefined) metadata.creator = creator;

  const meta = gpx['metadata'] as AnyRecord | undefined;
  if (meta && typeof meta === 'object') {
    const name = textOf(meta['name']);
    if (name !== undefined) metadata.name = name;
    const desc = textOf(meta['desc']) ?? textOf(meta['description']);
    if (desc !== undefined) metadata.description = desc;
    const t = isoToEpochMs(textOf(meta['time']));
    if (t !== undefined) metadata.time = t;
  }
  // Top-level <name>/<desc> are valid in many real files too.
  if (metadata.name === undefined) {
    const n = textOf(gpx['name']);
    if (n !== undefined) metadata.name = n;
  }

  const points: TrackPoint[] = [];

  for (const trk of asArray<AnyRecord>(gpx['trk'])) {
    for (const seg of asArray<AnyRecord>(trk['trkseg'])) {
      for (const pt of asArray<AnyRecord>(seg['trkpt'])) {
        const parsedPt = parsePoint(pt);
        if (parsedPt) points.push(parsedPt);
      }
    }
  }
  // Routes are a fallback when there are no track points — but the check must
  // stay OUTSIDE the loop: re-testing it per <rte> made the first non-empty
  // route trip the guard, silently dropping every subsequent route.
  if (points.length === 0) {
    for (const rte of asArray<AnyRecord>(gpx['rte'])) {
      for (const pt of asArray<AnyRecord>(rte['rtept'])) {
        const parsedPt = parsePoint(pt);
        if (parsedPt) points.push(parsedPt);
      }
    }
  }
  const hasTrackOrRoutePoints = points.length > 0;

  // Always preserve <wpt> markers with their labels.
  const waypoints: GpxWaypoint[] = [];
  for (const pt of asArray<AnyRecord>(gpx['wpt'])) {
    const w = parseWaypoint(pt);
    if (w) waypoints.push(w);
  }

  // Back-compat: a waypoint-only file still yields a "track" from its points.
  if (points.length === 0) {
    for (const pt of asArray<AnyRecord>(gpx['wpt'])) {
      const parsedPt = parsePoint(pt);
      if (parsedPt) points.push(parsedPt);
    }
  }

  return { metadata, points, waypoints, hasTrackOrRoutePoints };
}

/**
 * Serialize points to a valid GPX 1.1 string with a single <trk>/<trkseg>.
 * Coordinates are rounded to 7 decimals, elevation to 2. `<ele>`/`<time>` are
 * emitted only when defined on the source point.
 */
export function buildGpx(args: { points: TrackPoint[]; metadata?: GpxMetadata }): string {
  const { points, metadata } = args;

  const trkpts = points.map((p) => {
    const node: AnyRecord = {
      [`${ATTR_PREFIX}lat`]: round(p.latitude, 7),
      [`${ATTR_PREFIX}lon`]: round(p.longitude, 7),
    };
    if (p.altitude !== undefined && Number.isFinite(p.altitude)) {
      node['ele'] = round(p.altitude, 2);
    }
    if (p.time !== undefined && Number.isFinite(p.time) && p.time > 0) {
      node['time'] = epochMsToIso(p.time);
    }
    if (p.speed !== undefined && Number.isFinite(p.speed) && p.speed >= 0) {
      node['speed'] = round(p.speed, 3);
    }
    return node;
  });

  const metaNode: AnyRecord = {};
  if (metadata?.name !== undefined) metaNode['name'] = metadata.name;
  if (metadata?.description !== undefined) metaNode['desc'] = metadata.description;
  if (metadata?.time !== undefined) metaNode['time'] = epochMsToIso(metadata.time);

  const gpx: AnyRecord = {
    [`${ATTR_PREFIX}version`]: '1.1',
    [`${ATTR_PREFIX}creator`]: 'Inukshuk',
    [`${ATTR_PREFIX}xmlns`]: GPX_NS,
  };
  if (Object.keys(metaNode).length > 0) gpx['metadata'] = metaNode;
  gpx['trk'] = {
    ...(metadata?.name !== undefined ? { name: metadata.name } : {}),
    trkseg: { trkpt: trkpts },
  };

  const doc = builder.build({ gpx });
  return `<?xml version="1.0" encoding="UTF-8"?>\n${doc}`;
}
