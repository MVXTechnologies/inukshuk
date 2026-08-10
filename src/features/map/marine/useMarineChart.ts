import { encodePng } from '@core/encoding/png';
import {
  depthChartCorners,
  maskLandAbove,
  renderDepthChart,
  selectSoundings,
  soundingsFeatureCollection,
  type SoundingProperties,
} from '@core/geo/depthChart';
import { parseFloat32Grid, type FloatGrid } from '@core/geo/floatTiff';
import {
  depthChartCacheKey,
  depthFetchBbox,
  needsDepthReanchor,
  DEPTH_MAX_GRID_DIM,
  type GeoBbox,
} from '@core/geo/marineDepth';
import { packCellBbox, packCellIndex, packCellKey } from '@core/geo/marinePacks';
import {
  bboxContains,
  marineGridUrls,
  marineRasterUrl,
  marineSourceById,
  marineSourceLadder,
  type MarineSource,
  type MarineSourceId,
} from '@core/geo/marineSources';
import type { LngLat } from '@core/models';
import * as marinePackFiles from '@data/marinePacks';
import * as storage from '@data/storage';
import type { FeatureCollection, Point } from 'geojson';
import { useEffect, useRef, useState } from 'react';

/**
 * The client-rendered nautical depth chart (marine wave D §D2, worldwide in
 * §D3, offline in §D4): fetch the raw depth grid for the settled viewport,
 * render the ENC-style bands + contours to a PNG in JS, write it to the
 * cache and hand MapLibre a georeferenced `file://` image source — the
 * PDF-overlay mechanic, so the drape sits BELOW wave B's labels layers (a
 * GLView would cover them).
 *
 * Where the data comes from is a LADDER, not a single host
 * (`@core/geo/marineSources`), and the answer is reported back so the legend
 * can name it:
 *
 *   1. a downloaded offline pack that fully contains the viewport — free,
 *      instant and radio-off;
 *   2. CHS NONNA (Canada) → NOAA NCEI (US waters) → EMODnet (European seas),
 *      each tried in turn until one answers with surveyed cells;
 *   3. a raster drape (GEBCO worldwide, NOAA ENC Online in US waters) when
 *      no grid source can serve this viewport at all.
 *
 * Behaviour mirrors `useWindField`: bbox-quantized fetches, a module-level
 * LRU so pans back to a visited region re-drape instantly, and TOTAL silence
 * on failure — no network, an XML error body, a land-only region or a
 * too-wide viewport all settle to `chart: null`. Rendering happens once per
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
  /** Which ladder rung produced it. */
  sourceId: MarineSourceId;
  /** True when it came off a downloaded pack rather than the network. */
  offline: boolean;
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

/** Terrain models carry land elevations; mask them before they render. */
function maskForSource(grid: FloatGrid | null, source: MarineSource): FloatGrid | null {
  const cutoff = source.grid?.landCutoffM;
  if (grid === null || cutoff === undefined || cutoff === null) return grid;
  return maskLandAbove(grid, cutoff);
}

/** Render + persist a chart from a source's grids, or null when unusable. */
function buildChart(
  source: MarineSource,
  primary: FloatGrid,
  secondary: FloatGrid | null,
  bbox: GeoBbox,
  imperial: boolean,
  offline: boolean,
): MarineChart | null {
  const crs = source.grid?.crs ?? 'EPSG:3857';
  const image = renderDepthChart(primary, secondary);
  if (image === null) return null;
  const png = encodePng(image.width, image.height, image.rgba);
  const uri = storage.writeChartPng('marine-depth-chart', png);
  const snd = soundingsFeatureCollection(selectSoundings(primary, secondary, crs), imperial);
  return {
    drape: { uri, coordinates: depthChartCorners(primary, crs) },
    soundings: snd,
    bbox,
    sourceId: source.id,
    offline,
  };
}

/**
 * The stored pack cell that fully contains a viewport, or null. Partial
 * coverage is deliberately refused: a drape that stops halfway across the
 * screen would read as "no data here", which is a lie.
 */
function packCellCovering(
  sourceId: MarineSourceId,
  view: GeoBbox,
  installed: ReadonlySet<string>,
): { key: string; bbox: GeoBbox } | null {
  const latIdx = packCellIndex((view.south + view.north) / 2);
  const lonIdx = packCellIndex((view.west + view.east) / 2);
  const key = packCellKey(sourceId, latIdx, lonIdx);
  if (!installed.has(key)) return null;
  const bbox = packCellBbox(latIdx, lonIdx);
  return bboxContains(bbox, view) ? { key, bbox } : null;
}

export interface MarineChartState {
  /** The chart to drape, or null (loading / unavailable / out of scope). */
  chart: MarineChart | null;
  /**
   * True once a fetch settled with nothing to draw — the caller re-enables
   * a raster drape so the map never sits bare (silent degrade).
   */
  fallback: boolean;
  /**
   * The source on screen: the rung that rendered, or the raster rung we fell
   * back to, or null when there is nothing at all. The legend prints it —
   * "GEBCO 2025 · ~450 m" must never masquerade as a hydrographic survey.
   */
  sourceId: MarineSourceId | null;
  /**
   * Tile-URL template for the fallback drape, or null to keep the legacy
   * CHS WMS pair (`marineLayers.marineTileUrl`).
   */
  rasterUrl: string | null;
}

const IDLE: MarineChartState = { chart: null, fallback: false, sourceId: null, rasterUrl: null };

const EMPTY_PACKS: ReadonlySet<string> = new Set<string>();

function stateForChart(chart: MarineChart): MarineChartState {
  return { chart, fallback: false, sourceId: chart.sourceId, rasterUrl: null };
}

/**
 * @param active  marine mode on, 2D, screen focused, map loaded.
 * @param bounds  the settled viewport (null while unknown).
 * @param imperial units for the spot-sounding numbers.
 * @param installedPacks keys of the offline pack cells on disk.
 * @param packVersion bumps whenever the pack inventory changes (cache key).
 */
export function useMarineChart(
  active: boolean,
  bounds: GeoBbox | null,
  imperial: boolean,
  installedPacks: ReadonlySet<string> = EMPTY_PACKS,
  packVersion = 0,
): MarineChartState {
  const [state, setState] = useState<MarineChartState>(IDLE);
  // The bbox a render is anchored to; a settled camera inside it is a no-op.
  const anchorRef = useRef<GeoBbox | null>(null);

  useEffect(() => {
    // State resets go through a 0-timeout, never a synchronous setState in
    // the effect body (the cascading-render lint rule; the cached-hit path
    // below and useWindField do the same).
    const settle = (next: MarineChartState): (() => void) => {
      const t = setTimeout(() => setState(next), 0);
      return () => clearTimeout(t);
    };
    const clearLater = (): (() => void) => {
      anchorRef.current = null;
      return settle(IDLE);
    };
    if (!active) return clearLater();
    if (bounds === null) return;
    const anchor = anchorRef.current;
    if (anchor !== null && !needsDepthReanchor(anchor, bounds)) return;
    const bbox = depthFetchBbox(bounds);
    // Too wide / degenerate: the flat chart-blue water fill carries the
    // look, no drape. Not a failure — no raster fallback either (a 450 m
    // global grid magnified to a continent is exactly what wave D removed).
    if (bbox === null) return clearLater();
    const key = `${depthChartCacheKey(bbox)}|${packVersion}`;
    const cached = chartCache.get(key);
    if (cached !== undefined) {
      chartCache.delete(key);
      chartCache.set(key, cached);
      anchorRef.current = bbox;
      return settle(stateForChart(cached));
    }

    const ladder = marineSourceLadder(bbox);
    const ctl = new AbortController();
    const kill = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    let cancelled = false;
    void (async () => {
      let chart: MarineChart | null = null;
      // True once the progressive coarse pass has put something on screen.
      let previewed = false;
      // --- 1. A downloaded pack that covers the viewport wins outright. ---
      for (const source of ladder) {
        if (chart !== null || source.grid === null) continue;
        // Checked against the LIVE viewport, not the padded fetch bbox: the
        // pad exists to buy the network request some slack, and demanding a
        // 0.1° cell contain it would make packs almost never usable.
        const cell = packCellCovering(source.id, bounds, installedPacks);
        if (cell === null) continue;
        try {
          const bytes = await marinePackFiles.readPackCell(cell.key);
          if (bytes === null) continue;
          const grid = maskForSource(parseFloat32Grid(bytes), source);
          if (!hasData(grid) || grid === null) continue;
          chart = buildChart(source, grid, null, cell.bbox, imperial, true);
        } catch {
          // Unreadable pack file: fall through to the network ladder.
        }
      }

      // --- 2. The network ladder, best rung first. ---
      for (const source of ladder) {
        if (chart !== null || cancelled || source.grid === null) continue;
        try {
          const urls = marineGridUrls(source, bbox, DEPTH_MAX_GRID_DIM);
          const densePromise =
            urls[0] === undefined ? Promise.resolve(null) : fetchGrid(urls[0], ctl.signal);
          // A coarse-fringe failure must never fail the chart.
          const coarsePromise =
            urls[1] === undefined
              ? Promise.resolve(null)
              : fetchGrid(urls[1], ctl.signal).catch(() => null);
          // PROGRESSIVE FIRST PAINT (perf fix 2026-08-10, owner: "map
          // loading for the marine charts is very slow"). The coarse-fringe
          // grid is ~20x smaller on the wire than the dense one — measured
          // 41 kB / 397 ms against 922 kB / 1150 ms over Quebec City — and
          // ~5x smaller per axis, so rendering it costs ~1/25 of the crisp
          // pass (4 ms vs 1103 ms measured). Showing it the moment it lands
          // puts a correct, if soft, chart on screen at ~0.4 s instead of
          // ~2.5 s; the crisp pass then swaps into the same image source in
          // place. The previous drape holds until one of them lands, so the
          // map never blanks. Sources that publish only one grid simply have
          // no earlier answer to show and wait for the crisp pass.
          void coarsePromise
            .then((g) => {
              // `chart !== null` is NOT redundant with `previewed`. The dense
              // fetch can reject fast (NONNA 404s outside its coverage) while
              // this rung's coarse request is still in flight; the loop then
              // moves on, a LOWER rung renders a crisp chart, and ten seconds
              // later the abandoned coarse grid lands and would replace it
              // with a blurry one — and rename the source in the legend.
              // Reading `chart` here closes over the loop's live result, so a
              // preview can only ever fill an empty screen.
              if (cancelled || previewed || chart !== null) return;
              const masked = maskForSource(g, source);
              if (masked === null || !hasData(masked)) return;
              const preview = buildChart(source, masked, null, bbox, imperial, false);
              if (preview === null || cancelled) return;
              previewed = true;
              setState(stateForChart(preview));
            })
            .catch(() => undefined);
          const [first, second] = await Promise.all([densePromise, coarsePromise]);
          if (cancelled) return;
          const primaryRaw = maskForSource(first, source);
          const secondaryRaw = maskForSource(second, source);
          if (!hasData(primaryRaw) && !hasData(secondaryRaw)) continue;
          // Render against whichever grid has geometry; the dense one is the
          // georeference anchor when present (finer cells = crisper output).
          const primary = primaryRaw ?? secondaryRaw;
          const secondary = primaryRaw !== null ? secondaryRaw : null;
          if (primary === null) continue;
          chart = buildChart(source, primary, secondary, bbox, imperial, false);
        } catch {
          // Offline / aborted / host unreachable / disk full: next rung.
        }
      }
      clearTimeout(kill);
      if (cancelled) return;

      // Anchor either way so a failed region doesn't refetch on every settle.
      // A pack drape anchors to its own CELL, so panning off the cell edge
      // re-renders instead of trailing an image that stops mid-screen.
      anchorRef.current = chart !== null && chart.offline ? chart.bbox : bbox;
      if (chart !== null) {
        chartCache.set(key, chart);
        if (chartCache.size > CACHE_MAX) {
          const oldest = chartCache.keys().next().value;
          if (oldest !== undefined) chartCache.delete(oldest);
        }
        setState(stateForChart(chart));
        return;
      }

      // A progressive pass already on screen is a real answer: never pull it
      // back down to a coarse worldwide raster because the crisp pass failed.
      if (previewed) return;

      // --- 3. Nothing renderable: drape whatever imagery this region has. ---
      const rasterRung = ladder.find((s) => marineRasterUrl(s) !== null) ?? null;
      setState({
        chart: null,
        fallback: true,
        sourceId: rasterRung?.id ?? ladder[0]?.id ?? null,
        rasterUrl: rasterRung === null ? null : marineRasterUrl(rasterRung),
      });
    })();

    return () => {
      cancelled = true;
      clearTimeout(kill);
      ctl.abort();
    };
  }, [active, bounds, imperial, installedPacks, packVersion]);

  return state;
}

/** The catalog entry behind a reported source id (legend/attribution). */
export function marineChartSource(id: MarineSourceId | null): MarineSource | null {
  return id === null ? null : marineSourceById(id);
}
