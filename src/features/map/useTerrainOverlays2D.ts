import { parseRegionPayload } from '@core/map/regionPayload';
import { bytesToBase64 } from '@core/encoding/base64';
import { contourFeatures, type ContourFeatures } from '@core/geo/contours';
import { coverageScaleChanged, padBounds, viewStillCovered } from '@core/geo/overlayCoverage';
import { slopeStepFor } from '@core/geo/terrainJob';
import * as storage from '@data/storage';
import type { MapRef } from '@maplibre/maplibre-react-native';
import { beginBusyTask, type BusyTaskHandle } from '@state/busyTasksStore';
import { useSettingsStore } from '@state/settingsStore';
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { BoundingBox } from '@core/models';
import { fetchDemTileBytes, prefetchDemTiles } from './dem';
import { computeTerrain } from './terrainWorker';

/**
 * The 2D map's terrain overlays: a slope-band raster (PNG draped via
 * ImageSource, mirroring the PDF-overlay pipeline) and marching-squares
 * contour polylines (GeoJSON line layers), computed from the same offline-
 * cached Terrarium DEM the 3D terrain uses and bound to the same persisted
 * settings — so 2D and 3D always show the same analysis.
 *
 * The camera settling (`boundsVersion`: the host bumps it on EVERY
 * onRegionDidChange — rotated/pitched cameras included, their bounds just
 * cover a larger trapezoid bbox) or any overlay setting changing prompts a
 * check. Each compute covers the viewport plus half a viewport on every side,
 * and is KEPT while the view stays well inside it — so panning shows no cut
 * edge and most pans cost nothing. Once computed, the DEM tiles for the next
 * ring out are prefetched, so the eventual recompute doesn't wait on the
 * network either.
 *
 * The heavy part — Terrarium decode, slope, PNG encode, contour heightmap —
 * runs on a worklet runtime (`terrainWorker`, #722): the JS thread only reads
 * tile files, writes a small PNG and builds the contour GeoJSON. Each stage
 * registers in the busy-task store for the status chip (#721).
 */

/** ImageSource corners: [TL, TR, BR, BL] as [lng, lat]. */
type Corners = [[number, number], [number, number], [number, number], [number, number]];

export interface TerrainOverlays2D {
  slope: { uri: string; coordinates: Corners } | null;
  contours: ContourFeatures | null;
  /** Non-null when the last compute failed (e.g. offline without cached DEM). */
  error: string | null;
}

/**
 * Compute half a viewport beyond the screen on every side (2× the width and
 * height), so a pan reveals already-drawn contours instead of a cut edge.
 */
const PAD = 0.5;
/**
 * Grid resolution for the contour analysis. The area is ~1.5× wider than the
 * old 15 %-padded one, so the grid grows to match and keeps the same detail.
 */
const GRID = 384;
/**
 * Longest side of the slope image. The slope itself is computed on every DEM
 * pixel (up to 8 × 256 = 2048 a side); the result is block-averaged down to
 * at most this so the PNG encode stays quick. The viewport shows half the
 * image's width, so ~500 image pixels span the screen — smooth once the
 * layer resamples linearly (see SLOPE_LAYER) and the band edges blend
 * (`slopeOverlayColor`).
 */
const SLOPE_MAX_PX = 1024;
/** DEM tiles per side for the bigger area (6 would drop a zoom level). */
const MAX_TILES = 8;
/** Recompute once the view gets within this fraction of its size of the covered edge. */
const EDGE_MARGIN = 0.15;
/** Prefetch the ring beyond the computed area (1.5 viewports on every side). */
const PREFETCH_PAD = 1.5;
/** Settle delay after a region change before fetching DEM tiles. */
const DEBOUNCE_MS = 350;

export function useTerrainOverlays2D({
  mapRef,
  boundsVersion,
  active,
  contoursFromTiles = false,
}: {
  mapRef: RefObject<MapRef | null>;
  boundsVersion: number;
  /** False while the 3D view (or anything else) makes 2D overlays moot. */
  active: boolean;
  /**
   * The base map draws contours from served vector tiles (the Stone & Paper
   * map): don't also compute them here. Slope shading is unaffected.
   */
  contoursFromTiles?: boolean;
}): TerrainOverlays2D {
  const slopeOn = useSettingsStore((s) => s.terrainSlope);
  const contoursSetting = useSettingsStore((s) => s.terrainContours);
  const contoursOn = contoursSetting && !contoursFromTiles;
  const intervalM = useSettingsStore((s) => s.terrainContourIntervalM);
  const slopeMinDeg = useSettingsStore((s) => s.terrainSlopeMinDeg);
  const slopeMaxDeg = useSettingsStore((s) => s.terrainSlopeMaxDeg);

  const [state, setState] = useState<TerrainOverlays2D>({
    slope: null,
    contours: null,
    error: null,
  });
  const reqIdRef = useRef(0);
  // Which of the two slope files the map shows now. The next image goes to
  // the OTHER one: MapLibre ignores a url it already has, so writing the
  // shown file again left the OLD image stretched over the NEW corners
  // (#722 — slot by request parity collided whenever a request in between
  // was skipped or superseded, i.e. more often than not).
  const shownSlotRef = useRef<0 | 1 | null>(null);
  // What the current result covers: its tile-aligned bbox and the settings it
  // was computed with. Kept while the view stays well inside the bbox.
  const coveredRef = useRef<{ bbox: BoundingBox; knobs: string } | null>(null);

  const enabled = active && (slopeOn || contoursOn);

  useEffect(() => {
    if (!enabled) {
      // Invalidate the coverage key so re-enabling recomputes, and bump the
      // request id so any in-flight pipeline bails at its next checkpoint —
      // otherwise leaving the map screen (tabs keep it mounted) let a pending
      // DEM fetch run on into the full slope/contour compute in the
      // background. The stale state object is hidden by the `enabled` guard
      // on the return value below.
      reqIdRef.current += 1;
      coveredRef.current = null;
      return;
    }
    const reqId = ++reqIdRef.current;
    const timer = setTimeout(() => {
      void (async () => {
        // Parsed: an empty or bounds-less view (@core/map/regionPayload) draws nothing new.
        const view = parseRegionPayload(
          await mapRef.current?.getViewState().catch(() => undefined),
        );
        if (!view?.bounds || reqId !== reqIdRef.current) return;
        const [w, s, e, n] = view.bounds;
        const viewport: BoundingBox = { minLng: w, minLat: s, maxLng: e, maxLat: n };
        const bounds = padBounds(viewport, PAD);
        const knobs = [slopeOn, contoursOn, intervalM, slopeMinDeg, slopeMaxDeg].join('|');
        // Keep the current result while the view is still well inside it, at
        // a similar zoom, with the same settings: nothing new to draw.
        const covered = coveredRef.current;
        if (
          covered !== null &&
          covered.knobs === knobs &&
          viewStillCovered(viewport, covered.bbox, EDGE_MARGIN) &&
          !coverageScaleChanged(viewport, covered.bbox, PAD)
        ) {
          return;
        }

        const busy: BusyTaskHandle[] = [];
        try {
          busy.push(beginBusyTask('tiles'));
          const dem = await fetchDemTileBytes(bounds, MAX_TILES);
          busy.pop()?.finish();
          if (reqId !== reqIdRef.current) return;

          const width = dem.cols * 256;
          const height = dem.rows * 256;
          busy.push(beginBusyTask(slopeOn ? 'slope' : 'contours'));
          const out = await computeTerrain({
            tiles: dem.tiles,
            tileKeys: dem.keys,
            cols: dem.cols,
            rows: dem.rows,
            z: dem.range.z,
            topRow: dem.range.minY * 256,
            slope: slopeOn
              ? {
                  minDeg: slopeMinDeg,
                  maxDeg: slopeMaxDeg,
                  step: slopeStepFor(width, height, SLOPE_MAX_PX),
                }
              : null,
            heightmapGrid: contoursOn ? GRID : 0,
          });
          // Superseded while queued, or a newer request arrived meanwhile.
          if (out === null || reqId !== reqIdRef.current) return;

          let slope: TerrainOverlays2D['slope'] = null;
          if (out.slopePng !== null) {
            const slot = shownSlotRef.current === 0 ? 1 : 0;
            const uri = storage.writeOverlayPng(`slope2d-${slot}`, bytesToBase64(out.slopePng));
            shownSlotRef.current = slot;
            slope = {
              uri,
              coordinates: [
                [dem.bbox.minLng, dem.bbox.maxLat],
                [dem.bbox.maxLng, dem.bbox.maxLat],
                [dem.bbox.maxLng, dem.bbox.minLat],
                [dem.bbox.minLng, dem.bbox.minLat],
              ],
            };
          }
          const contours =
            out.heightmap !== null
              ? contourFeatures({ ...out.heightmap, bbox: dem.bbox }, intervalM)
              : null;
          coveredRef.current = { bbox: dem.bbox, knobs };
          setState({ slope, contours, error: null });
          // Head start for the next pan: cache the DEM tiles one ring out.
          void prefetchDemTiles(padBounds(viewport, PREFETCH_PAD), dem.range.z);
        } catch (err) {
          if (reqId !== reqIdRef.current) return;
          coveredRef.current = null;
          setState({
            slope: null,
            contours: null,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          for (const b of busy) b.finish();
        }
      })();
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [enabled, slopeOn, contoursOn, intervalM, slopeMinDeg, slopeMaxDeg, boundsVersion, mapRef]);

  if (!enabled) return { slope: null, contours: null, error: null };
  return {
    slope: slopeOn ? state.slope : null,
    contours: contoursOn ? state.contours : null,
    error: state.error,
  };
}
