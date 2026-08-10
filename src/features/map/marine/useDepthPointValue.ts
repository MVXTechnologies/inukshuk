import { parseFloat32Grid } from '@core/geo/floatTiff';
import { depthPointUrl, nearestValidDepth } from '@core/geo/marineDepth';
import type { LatLng } from '@core/models';
import { useEffect, useState } from 'react';

/**
 * Tap-for-depth (marine wave D §D1): one WCS GetCoverage for the 3×3-cell
 * neighbourhood around the tapped point, answering the nearest surveyed
 * NONNA cell's value in metres (negative = below chart datum). The 3×3 read
 * is the seam fallback — NONNA's 1-px nodata lines run along every 0.01°
 * granule boundary and a round coordinate lands on one often enough to
 * matter (plan §2, verified live).
 *
 * Ladder: the dense NONNA 10 coverage first, the coarse NONNA 100 when the
 * dense grid has no cell there. Same keyed-result idiom as
 * `useWeatherPointValue`: a stale key reads as 'loading', and every failure
 * (offline, XML error body, land) settles to 'error' — the chip line just
 * doesn't appear.
 */

export interface DepthPointQuery {
  status: 'loading' | 'error' | 'ready';
  /** Metres, NONNA convention: negative below chart datum, positive drying. */
  valueM: number | null;
}

const LOADING: DepthPointQuery = { status: 'loading', valueM: null };
const FETCH_TIMEOUT_MS = 12_000;

function requestKey(at: LatLng): string {
  return `${at.latitude.toFixed(6)},${at.longitude.toFixed(6)}`;
}

async function probe(
  coverage: 'nonna10' | 'nonna100',
  at: LatLng,
  signal: AbortSignal,
): Promise<number | null> {
  const res = await fetch(depthPointUrl(coverage, at.latitude, at.longitude), { signal });
  if (!res.ok) return null;
  const grid = parseFloat32Grid(new Uint8Array(await res.arrayBuffer()));
  return grid === null ? null : nearestValidDepth(grid);
}

export function useDepthPointValue(at: LatLng): DepthPointQuery {
  const [result, setResult] = useState<{ key: string; query: DepthPointQuery } | null>(null);

  useEffect(() => {
    const key = requestKey(at);
    const ctl = new AbortController();
    const kill = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    let cancelled = false;
    void (async () => {
      let valueM: number | null = null;
      try {
        valueM = await probe('nonna10', at, ctl.signal);
        valueM ??= await probe('nonna100', at, ctl.signal);
      } catch {
        // Offline / aborted / unreachable — silent, the line is dropped.
      }
      clearTimeout(kill);
      if (cancelled) return;
      setResult({
        key,
        query: valueM !== null ? { status: 'ready', valueM } : { status: 'error', valueM: null },
      });
    })();
    return () => {
      cancelled = true;
      clearTimeout(kill);
      ctl.abort();
    };
  }, [at]);

  return result !== null && result.key === requestKey(at) ? result.query : LOADING;
}
