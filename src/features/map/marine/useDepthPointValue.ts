import { maskLandAbove } from '@core/geo/depthChart';
import { parseFloat32Grid } from '@core/geo/floatTiff';
import { depthPointUrl, nearestValidDepth } from '@core/geo/marineDepth';
import { packCellIndex, packCellKey } from '@core/geo/marinePacks';
import {
  marinePointUrl,
  marineSourceLadder,
  parseMarinePointDepth,
  sampleGridDepth,
  type MarineSource,
} from '@core/geo/marineSources';
import type { LatLng } from '@core/models';
import * as marinePackFiles from '@data/marinePacks';
import { useEffect, useState } from 'react';

/**
 * Tap-for-depth (marine wave D §D1, worldwide in §D3, offline in §D4): the
 * depth under the finger, from whichever source can answer it.
 *
 * The ladder mirrors the chart's:
 *
 *   1. a downloaded pack cell containing the point — a local array read, no
 *      network, instant (and the only path that works with the radio off);
 *   2. CHS NONNA's WCS 3×3-cell GetCoverage in Canada (the 3×3 read is the
 *      seam fallback — NONNA's 1-px nodata lines run along every 0.01°
 *      granule boundary and a round coordinate lands on one often enough to
 *      matter, verified live);
 *   3. NOAA NCEI's ArcGIS `identify` in US waters, EMODnet's `depth_sample`
 *      REST in European seas, and NCEI globally for everything else — both
 *      JSON, both re-probed live 2026-08-10.
 *
 * Same keyed-result idiom as `useWeatherPointValue`: a stale key reads as
 * 'loading', and every failure (offline, XML error body, land) settles to
 * 'error' — the chip line just doesn't appear.
 */

export interface DepthPointQuery {
  status: 'loading' | 'error' | 'ready';
  /** Metres, NONNA convention: negative below chart datum, positive drying. */
  valueM: number | null;
  /** Who answered — shown muted on the chip so the number is never anonymous. */
  sourceLabel: string | null;
}

const LOADING: DepthPointQuery = { status: 'loading', valueM: null, sourceLabel: null };
const EMPTY_PACKS: ReadonlySet<string> = new Set<string>();
const FETCH_TIMEOUT_MS = 12_000;

function requestKey(at: LatLng): string {
  return `${at.latitude.toFixed(6)},${at.longitude.toFixed(6)}`;
}

/** A degenerate viewport around the tap — the ladder wants a box. */
function pointBox(at: LatLng): {
  west: number;
  south: number;
  east: number;
  north: number;
} {
  const d = 1e-4;
  return {
    west: at.longitude - d,
    south: at.latitude - d,
    east: at.longitude + d,
    north: at.latitude + d,
  };
}

/** Read the depth out of a downloaded pack cell, or null. */
async function probePack(
  source: MarineSource,
  at: LatLng,
  installed: ReadonlySet<string>,
): Promise<number | null> {
  const grid = source.grid;
  if (grid === null) return null;
  const latIdx = packCellIndex(at.latitude);
  const lonIdx = packCellIndex(at.longitude);
  const key = packCellKey(source.id, latIdx, lonIdx);
  if (!installed.has(key)) return null;
  const bytes = await marinePackFiles.readPackCell(key);
  if (bytes === null) return null;
  const parsed = parseFloat32Grid(bytes);
  if (parsed === null) return null;
  const masked = grid.landCutoffM === null ? parsed : maskLandAbove(parsed, grid.landCutoffM);
  // The stored file carries its own georeference, so the sample is exact.
  return sampleGridDepth(masked, grid.crs, at.latitude, at.longitude);
}

/** Ask a source's point endpoint. Null on anything unexpected. */
async function probeNetwork(
  source: MarineSource,
  at: LatLng,
  signal: AbortSignal,
): Promise<number | null> {
  const point = source.point;
  if (point === null) return null;
  if (point.kind === 'wcs-grid') {
    // NONNA's dense grid first, then the coarse one over its fringe.
    for (const coverage of ['nonna10', 'nonna100'] as const) {
      const res = await fetch(depthPointUrl(coverage, at.latitude, at.longitude), { signal });
      if (!res.ok) continue;
      const grid = parseFloat32Grid(new Uint8Array(await res.arrayBuffer()));
      const value = grid === null ? null : nearestValidDepth(grid);
      if (value !== null) return value;
    }
    return null;
  }
  const url = marinePointUrl(source, at.latitude, at.longitude);
  if (url === null) return null;
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  const body: unknown = await res.json();
  const value = parseMarinePointDepth(point.kind, body);
  // The terrain-model sources answer land elevations too; a hilltop is not
  // a depth, so anything clearly above datum is reported as "no reading".
  const cutoff = source.grid?.landCutoffM;
  if (value !== null && cutoff !== undefined && cutoff !== null && value >= cutoff) return null;
  return value;
}

export function useDepthPointValue(
  at: LatLng,
  installedPacks: ReadonlySet<string> = EMPTY_PACKS,
): DepthPointQuery {
  const [result, setResult] = useState<{ key: string; query: DepthPointQuery } | null>(null);

  useEffect(() => {
    const key = requestKey(at);
    const ctl = new AbortController();
    const kill = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    let cancelled = false;
    void (async () => {
      const ladder = marineSourceLadder(pointBox(at));
      let valueM: number | null = null;
      let sourceLabel: string | null = null;
      for (const source of ladder) {
        if (valueM !== null || cancelled) break;
        try {
          valueM = await probePack(source, at, installedPacks);
          if (valueM !== null) {
            sourceLabel = `${source.label} · offline`;
            break;
          }
        } catch {
          // Unreadable pack: try the network rung for the same source.
        }
        try {
          valueM = await probeNetwork(source, at, ctl.signal);
          if (valueM !== null) sourceLabel = source.point?.attribution ?? source.label;
        } catch {
          // Offline / aborted / unreachable — silent, try the next rung.
        }
      }
      clearTimeout(kill);
      if (cancelled) return;
      setResult({
        key,
        query:
          valueM !== null
            ? { status: 'ready', valueM, sourceLabel }
            : { status: 'error', valueM: null, sourceLabel: null },
      });
    })();
    return () => {
      cancelled = true;
      clearTimeout(kill);
      ctl.abort();
    };
  }, [at, installedPacks]);

  return result !== null && result.key === requestKey(at) ? result.query : LOADING;
}
