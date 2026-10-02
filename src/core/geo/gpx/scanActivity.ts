import type { TrackPoint } from '@core/models';

import { scanGpxTrack } from './scan';

/**
 * A fast GPX reader for statistics (Logbook statistics backfill): the
 * `<trkpt>` positions and segments of {@link scanGpxTrack}, plus each point's
 * `<ele>`, `<time>` and heart rate (`gpxtpx:hr`, `ns3:hr`, `heartrate` — any
 * namespace, as `parseGpx` reads it). A tag scan, several times faster than
 * the full XML parse, which matters when a 400-trail library is summarised
 * for the first time.
 *
 * Returns null for anything that isn't a plain track (the caller then falls
 * back to `parseGpx`), and for files whose point count disagrees with the
 * positions-only scan (a shape this reader doesn't understand).
 */

export interface ScannedActivity {
  points: TrackPoint[];
  segmentStarts: number[];
}

const LAT = /\slat\s*=\s*["']([^"']*)["']/;
const LON = /\slon\s*=\s*["']([^"']*)["']/;
const ELE = /<ele>\s*([^<]*?)\s*<\/ele>/;
const TIME = /<time>\s*([^<]*?)\s*<\/time>/;
const HR = /<(?:[A-Za-z_][\w.-]*:)?(?:hr|heartrate)>\s*([^<]*?)\s*<\//i;

function attr(re: RegExp, tag: string): number {
  const raw = re.exec(tag)?.[1];
  return raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw);
}

function child(re: RegExp, body: string): string | undefined {
  const raw = re.exec(body)?.[1];
  return raw === undefined || raw === '' ? undefined : raw;
}

export function scanGpxActivity(xml: string): ScannedActivity | null {
  const shape = scanGpxTrack(xml);
  if (shape === null) return null;
  const points: TrackPoint[] = [];
  let pos = 0;
  for (;;) {
    const i = xml.indexOf('<trkpt', pos);
    if (i === -1) break;
    const c = xml.charCodeAt(i + 6);
    // `<trkpt` followed by whitespace, '>' or '/': the element, not a longer name.
    if (!(c === 32 || c === 9 || c === 10 || c === 13 || c === 62 || c === 47)) {
      pos = i + 6;
      continue;
    }
    const tagEnd = xml.indexOf('>', i);
    if (tagEnd === -1) break;
    const tag = xml.slice(i + 6, tagEnd);
    let body = '';
    let next = tagEnd + 1;
    if (!tag.endsWith('/')) {
      const close = xml.indexOf('</trkpt>', tagEnd);
      if (close === -1) return null;
      body = xml.slice(tagEnd + 1, close);
      next = close + 8;
    }
    pos = next;
    const lat = attr(LAT, tag);
    const lon = attr(LON, tag);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    ) {
      continue;
    }
    const iso = child(TIME, body);
    const ms = iso === undefined ? Number.NaN : Date.parse(iso);
    const point: TrackPoint = {
      latitude: lat,
      longitude: lon,
      time: Number.isNaN(ms) ? 0 : ms,
      hasTime: !Number.isNaN(ms),
    };
    const ele = child(ELE, body);
    if (ele !== undefined) {
      const n = Number(ele);
      if (Number.isFinite(n)) point.altitude = n;
    }
    const hr = child(HR, body);
    if (hr !== undefined) {
      const n = Number(hr);
      if (Number.isFinite(n) && n > 0) point.heartRateBpm = n;
    }
    points.push(point);
  }
  if (points.length !== shape.points.length) return null;
  return { points, segmentStarts: shape.segmentStarts };
}
