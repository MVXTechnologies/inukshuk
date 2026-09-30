/**
 * A fast positions-only GPX reader (#465). Drawing a trail needs its
 * `<trkpt lat lon>` pairs and its `<trkseg>` boundaries — not elevations,
 * times, extensions or waypoints — and a full XML parse of a 1 Hz recording
 * (≈1 MB) is what made a large library's first draw take minutes on a phone.
 * This scans the text for the two tags instead, several times faster.
 *
 * It mirrors `parseGpx` for track points: one segment per non-empty
 * `<trkseg>` across every `<trk>`, invalid coordinates skipped. Anything it
 * cannot read as a plain track (no `<trkpt>` at all: a route, a waypoint-only
 * file, a namespaced document) returns null, and the caller falls back to
 * `parseGpx`.
 */

export interface ScannedTrack {
  points: { latitude: number; longitude: number }[];
  /** Indices into `points` where a new segment begins (never 0). */
  segmentStarts: number[];
}

const LAT = /\slat\s*=\s*["']([^"']*)["']/;
const LON = /\slon\s*=\s*["']([^"']*)["']/;

/** An attribute's number, NaN when absent or blank (like `parseGpx`). */
function attr(re: RegExp, tag: string): number {
  const raw = re.exec(tag)?.[1];
  return raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw);
}

/** Whether the character at `i` ends a tag name (so `<trkseg` ≠ `<trksegfoo`). */
function endsName(xml: string, i: number): boolean {
  const c = xml.charCodeAt(i);
  // whitespace, '>', '/'
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 62 || c === 47;
}

export function scanGpxTrack(xml: string): ScannedTrack | null {
  const points: { latitude: number; longitude: number }[] = [];
  const segmentStarts: number[] = [];
  let sawTrkpt = false;
  // Where the current <trkseg> began (-1: its first point is already in).
  let segmentStart = -1;
  let pos = 0;
  for (;;) {
    const i = xml.indexOf('<trk', pos);
    if (i === -1) break;
    if (xml.startsWith('seg', i + 4) && endsName(xml, i + 7)) {
      segmentStart = points.length;
      pos = i + 7;
      continue;
    }
    if (xml.startsWith('pt', i + 4) && endsName(xml, i + 6)) {
      sawTrkpt = true;
      const end = xml.indexOf('>', i);
      if (end === -1) break;
      const tag = xml.slice(i + 6, end);
      const lat = attr(LAT, tag);
      const lon = attr(LON, tag);
      if (
        Number.isFinite(lat) &&
        Number.isFinite(lon) &&
        Math.abs(lat) <= 90 &&
        Math.abs(lon) <= 180
      ) {
        // A boundary only where a non-empty segment follows points.
        if (segmentStart > 0) segmentStarts.push(segmentStart);
        segmentStart = -1;
        points.push({ latitude: lat, longitude: lon });
      }
      pos = end + 1;
      continue;
    }
    pos = i + 4;
  }
  return sawTrkpt && points.length > 0 ? { points, segmentStarts } : null;
}
