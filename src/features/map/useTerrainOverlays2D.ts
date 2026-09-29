import { bytesToBase64 } from '@core/encoding/base64';
import { contourFeatures, type ContourFeatures } from '@core/geo/contours';
import { coverageScaleChanged, padBounds, viewStillCovered } from '@core/geo/overlayCoverage';
import { slopeOverlayMercator } from '@core/geo/terrainAnalysis';
import * as storage from '@data/storage';
import type { MapRef } from '@maplibre/maplibre-react-native';
import { useSettingsStore } from '@state/settingsStore';
import { useEffect, useRef, useState, type RefObject } from 'react';
import UPNG from 'upng-js';
import type { BoundingBox } from '@core/models';
import { fetchDemMosaic, heightmapFromMosaic, prefetchDemTiles } from './dem';

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
        const view = await mapRef.current?.getViewState().catch(() => undefined);
        if (!view || reqId !== reqIdRef.current) return;
        const [w, s, e, n] = view.bounds as [number, number, number, number];
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

        // The slope raster, PNG encode and contour extraction each block the
        // JS thread for a noticeable chunk on-device; yielding between stages
        // keeps touches responsive and gives an abandoned request (new region,
        // screen left) a checkpoint to bail at instead of finishing for
        // nothing.
        const stale = async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          return reqId !== reqIdRef.current;
        };

        try {
          const dem = await fetchDemMosaic(bounds, MAX_TILES);
          if (reqId !== reqIdRef.current) return;

          let slope: TerrainOverlays2D['slope'] = null;
          if (slopeOn) {
            if (await stale()) return;
            const img = slopeOverlayMercator(
              dem.data,
              dem.width,
              dem.height,
              dem.range.z,
              dem.range.minY * 256,
              slopeMinDeg,
              slopeMaxDeg,
              Math.ceil(Math.max(dem.width, dem.height) / SLOPE_MAX_PX),
            );
            if (await stale()) return;
            const png = new Uint8Array(
              UPNG.encode(
                [
                  img.rgba.buffer.slice(
                    img.rgba.byteOffset,
                    img.rgba.byteOffset + img.rgba.byteLength,
                  ) as ArrayBuffer,
                ],
                img.width,
                img.height,
                0,
              ),
            );
            // Alternate between two file names: MapLibre caches by URL, so
            // rewriting one fixed path would keep showing the stale image.
            const uri = storage.writeOverlayPng(`slope2d-${reqId % 2}`, bytesToBase64(png));
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

          if (await stale()) return;
          const contours = contoursOn
            ? contourFeatures(heightmapFromMosaic(dem, GRID), intervalM)
            : null;
          if (reqId !== reqIdRef.current) return;
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
