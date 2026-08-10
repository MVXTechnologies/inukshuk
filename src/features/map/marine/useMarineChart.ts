import { encodePng } from '@core/encoding/png';
import {
  depthChartCorners,
  renderDepthChart,
  selectSoundings,
  soundingsFeatureCollection,
  type SoundingProperties,
} from '@core/geo/depthChart';
import { parseFloat32Grid, type FloatGrid } from '@core/geo/floatTiff';
import {
  depthChartCacheKey,
  depthCoverageUrl,
  depthFetchBbox,
  needsDepthReanchor,
  type GeoBbox,
} from '@core/geo/marineDepth';
import type { LngLat } from '@core/models';
import * as storage from '@data/storage';
import type { FeatureCollection, Point } from 'geojson';
import { useEffect, useRef, useState } from 'react';

/**
 * The client-rendered nautical depth chart (marine wave D §D2): fetch the raw
 * NONNA depth grid for the settled viewport over WCS, render the ENC-style
 * bands + contours to a PNG in JS, write it to the cache and hand MapLibre a
 * georeferenced `file://` image source — the PDF-overlay mechanic, so the
 * drape sits BELOW wave B's labels layers (a GLView would cover them).
 *
 * Behaviour mirrors `useWindField`: bbox-quantized fetches, a module-level
 * LRU so pans back to a visited region re-drape instantly, and TOTAL silence
 * on failure — no network, an XML error body, a land-only region or a
 * too-wide viewport all settle to `chart: null`, which the caller turns into
 * the legacy WMS drape (the pre-wave-D look). Rendering happens once per
 * settled camera, never during a gesture.
 */

const FETCH_TIMEOUT_MS = 20_000;
const CACHE_MAX = 6;

export interface MarineChartDrape {
  uri: string;
  coordinates: [LngLat, LngLat, LngLat, LngLat];
}

export interface MarineChart {
  drape: MarineChartDrape;
  soundings: FeatureCollection<Point, SoundingProperties>;
  /** The bbox the drape was rendered for (re-anchor checks). */
  bbox: GeoBbox;
}

/** Rendered charts by bbox cache key (session-only, like the wind cache). */
const chartCache = new Map<string, MarineChart>();

async function fetchGrid(url: string, signal: AbortSignal): Promise<FloatGrid | null> {
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  return parseFloat32Grid(new Uint8Array(await res.arrayBuffer()));
}

/** Does a grid hold any surveyed cell at all? (All-nodata = land/no coverage.) */
function hasData(grid: FloatGrid | null): boolean {
  if (grid === null) return false;
  for (let i = 0; i < grid.data.length; i++) {
    const v = grid.data[i];
    if (v !== undefined && Number.isFinite(v) && Math.abs(v) < 3e38) return true;
  }
  return false;
}

export interface MarineChartState {
  /** The chart to drape, or null (loading / unavailable / out of scope). */
  chart: MarineChart | null;
  /**
   * True once a fetch settled with nothing to draw — the caller re-enables
   * the legacy WMS drape so the map never sits bare (silent degrade).
   */
  fallback: boolean;
}

/**
 * @param active  marine mode on, 2D, online, screen focused, map loaded.
 * @param bounds  the settled viewport (null while unknown).
 * @param imperial units for the spot-sounding numbers.
 */
export function useMarineChart(
  active: boolean,
  bounds: GeoBbox | null,
  imperial: boolean,
): MarineChartState {
  const [state, setState] = useState<MarineChartState>({ chart: null, fallback: false });
  // The bbox a render is anchored to; a settled camera inside it is a no-op.
  const anchorRef = useRef<GeoBbox | null>(null);

  useEffect(() => {
    // State resets go through a 0-timeout, never a synchronous setState in
    // the effect body (the cascading-render lint rule; the cached-hit path
    // below and useWindField do the same).
    const clearLater = (): (() => void) => {
      anchorRef.current = null;
      const t = setTimeout(() => setState({ chart: null, fallback: false }), 0);
      return () => clearTimeout(t);
    };
    if (!active) return clearLater();
    if (bounds === null) return;
    const anchor = anchorRef.current;
    if (anchor !== null && !needsDepthReanchor(anchor, bounds)) return;
    const bbox = depthFetchBbox(bounds);
    // Too wide / degenerate: the flat chart-blue water fill carries the
    // look, no drape. Not a failure — no WMS fallback either (the server's
    // blocky mosaic at that zoom is exactly what wave D removed).
    if (bbox === null) return clearLater();
    const key = depthChartCacheKey(bbox);
    const cached = chartCache.get(key);
    if (cached !== undefined) {
      chartCache.delete(key);
      chartCache.set(key, cached);
      anchorRef.current = bbox;
      const t = setTimeout(() => setState({ chart: cached, fallback: false }), 0);
      return () => clearTimeout(t);
    }

    const ctl = new AbortController();
    const kill = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    let cancelled = false;
    void (async () => {
      let chart: MarineChart | null = null;
      try {
        // The dense grid carries the detail; the coarse one fills its fringe
        // (a NONNA 100 failure must never fail the chart — hence the catch).
        const [grid10, grid100] = await Promise.all([
          fetchGrid(depthCoverageUrl('nonna10', bbox), ctl.signal),
          fetchGrid(depthCoverageUrl('nonna100', bbox), ctl.signal).catch(() => null),
        ]);
        if (cancelled) return;
        if (hasData(grid10) || hasData(grid100)) {
          // Render against whichever grid has geometry; grid10 is the
          // georeference anchor when present (finer cells = crisper output).
          const primary = grid10 ?? grid100;
          const secondary = grid10 !== null ? grid100 : null;
          if (primary !== null) {
            const image = renderDepthChart(primary, secondary);
            if (image !== null) {
              const png = encodePng(image.width, image.height, image.rgba);
              const uri = storage.writeChartPng('marine-depth-chart', png);
              const soundings = soundingsFeatureCollection(
                selectSoundings(primary, secondary),
                imperial,
              );
              chart = {
                drape: { uri, coordinates: depthChartCorners(primary) },
                soundings,
                bbox,
              };
            }
          }
        }
      } catch {
        // Offline / aborted / host unreachable / disk full: silent.
      }
      clearTimeout(kill);
      if (cancelled) return;
      if (chart !== null) {
        anchorRef.current = bbox;
        chartCache.set(key, chart);
        if (chartCache.size > CACHE_MAX) {
          const oldest = chartCache.keys().next().value;
          if (oldest !== undefined) chartCache.delete(oldest);
        }
        setState({ chart, fallback: false });
      } else {
        // Nothing renderable here. Anchor anyway so a failed region doesn't
        // refetch on every settle inside it, and let the caller fall back to
        // the legacy WMS drape.
        anchorRef.current = bbox;
        setState({ chart: null, fallback: true });
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(kill);
      ctl.abort();
    };
  }, [active, bounds, imperial]);

  return state;
}
