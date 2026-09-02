/**
 * NRCan's NTS sheet index (`nts_snrc.kmz`) — the authoritative sheet geometry.
 *
 * {@link ntsSheetBbox} derives a sheet's extent from the NTS grid formula,
 * which only models the regular southern zone: above 60°N the 1:50k sheets
 * widen and the primary quadrangles change shape, so the formula returns null
 * and three quarters of CanTopo's published sheets would have no bbox at all.
 *
 * NRCan publishes the real cut lines as a KMZ index. Every 1:50k placemark in
 * it carries the sheet id, its toponym and the sheet polygon, at every
 * latitude — so the catalog generator reads the extent out of the index and
 * only falls back to the computed grid for a sheet the index somehow omits.
 *
 * Pure string work on purpose: the KML is a 78 MB document the generator
 * downloads in Node, but nothing here touches the network or the filesystem,
 * so the parsing is unit-testable on a handful of inline placemarks.
 */
import type { NtsBbox } from './nts';

/** What the index knows about one 1:50k sheet. */
export interface NtsIndexEntry {
  /** Toponym exactly as the index spells it, e.g. "QUÉBEC". Absent if blank. */
  toponym?: string;
  /** WGS84 [west, south, east, north] of the sheet polygon. */
  bbox?: NtsBbox;
}

/** 1:50k sheet id, e.g. "021L14". The index also holds 1:250k tiles ("021L"). */
const SHEET_NAME = /<name>\s*(\d{3}[A-Pa-p]\d{2})\s*<\/name>/;
const SNIPPET = /<snippet>([^<]*)<\/snippet>/;
/**
 * Only the polygon rings — a placemark's `<Point>` is its label anchor, and a
 * shared /g regex would carry `lastIndex` between placemarks, so build it per
 * call.
 */
function ringCoordsRe(): RegExp {
  return /<LinearRing>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/g;
}

/** Grow `bounds` ([w, s, e, n]) over a KML "lon,lat[,alt] …" coordinate list. */
function accumulateRing(coords: string, bounds: NtsBbox): boolean {
  let grew = false;
  for (const token of coords.split(/\s+/)) {
    if (token === '') continue;
    const parts = token.split(',');
    const lon = Number(parts[0]);
    const lat = Number(parts[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (Math.abs(lon) > 180 || Math.abs(lat) > 90) continue;
    bounds[0] = Math.min(bounds[0], lon);
    bounds[1] = Math.min(bounds[1], lat);
    bounds[2] = Math.max(bounds[2], lon);
    bounds[3] = Math.max(bounds[3], lat);
    grew = true;
  }
  return grew;
}

/** Extent of every polygon ring in one placemark, or null if it has none. */
function placemarkBbox(placemark: string): NtsBbox | null {
  const bounds: NtsBbox = [Infinity, Infinity, -Infinity, -Infinity];
  let grew = false;
  for (const ring of placemark.matchAll(ringCoordsRe())) {
    if (accumulateRing(ring[1] ?? '', bounds)) grew = true;
  }
  // A ring that collapsed to a point or a line is not a usable extent — the
  // manifest parser would drop such a bbox anyway, so report "no geometry".
  if (!grew || bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) return null;
  return bounds;
}

/**
 * Parse the KML inside `nts_snrc.kmz` into `sheet id → toponym + bbox`, keyed
 * by uppercase 1:50k id. 1:250k placemarks and anything unparseable are
 * skipped; the first placemark for a sheet wins. Never throws.
 */
export function parseNtsIndexKml(kml: string): Map<string, NtsIndexEntry> {
  const sheets = new Map<string, NtsIndexEntry>();
  let cursor = 0;
  for (;;) {
    const start = kml.indexOf('<Placemark', cursor);
    if (start < 0) break;
    const end = kml.indexOf('</Placemark>', start);
    if (end < 0) break;
    const placemark = kml.slice(start, end);
    cursor = end + '</Placemark>'.length;

    const id = SHEET_NAME.exec(placemark)?.[1];
    if (id === undefined) continue;
    const sheet = id.toUpperCase();
    if (sheets.has(sheet)) continue;

    const toponym = (SNIPPET.exec(placemark)?.[1] ?? '').trim();
    const bbox = placemarkBbox(placemark);
    sheets.set(sheet, {
      ...(toponym !== '' ? { toponym } : {}),
      ...(bbox !== null ? { bbox } : {}),
    });
  }
  return sheets;
}
