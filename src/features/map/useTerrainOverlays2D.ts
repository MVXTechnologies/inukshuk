import { bytesToBase64 } from '@core/encoding/base64';
import { contourFeatures, type ContourFeatures } from '@core/geo/contours';
import { slopeOverlayRgba } from '@core/geo/terrainAnalysis';
import * as storage from '@data/storage';
import type { MapRef } from '@maplibre/maplibre-react-native';
import { useSettingsStore } from '@state/settingsStore';
import { useEffect, useRef, useState, type RefObject } from 'react';
import UPNG from 'upng-js';
import { fetchHeightmap } from './dem';

/**
 * The 2D map's terrain overlays: a slope-band raster (PNG draped via
 * ImageSource, mirroring the PDF-overlay pipeline) and marching-squares
 * contour polylines (GeoJSON line layers), computed from the same offline-
 * cached Terrarium DEM the 3D terrain uses and bound to the same persisted
 * settings — so 2D and 3D always show the same analysis.
 *
 * Recomputes when the camera settles on a new region (`boundsVersion`: the
 * host bumps it on EVERY onRegionDidChange — rotated/pitched cameras
 * included, their bounds just cover a larger trapezoid bbox) or when any
 * overlay setting changes. Results cover the DEM's tile-aligned bbox (≥ the
 * viewport), so small pans often need no recompute.
 */

/** ImageSource corners: [TL, TR, BR, BL] as [lng, lat]. */
type Corners = [[number, number], [number, number], [number, number], [number, number]];

export interface TerrainOverlays2D {
  slope: { uri: string; coordinates: Corners } | null;
  contours: ContourFeatures | null;
  /** Non-null when the last compute failed (e.g. offline without cached DEM). */
  error: string | null;
}

/** Pad the visible bounds so small pans stay inside the computed area. */
const PAD = 0.15;
/** Grid resolution for the analysis (256 ≙ the 3D terrain mesh grid). */
const GRID = 256;
/** Settle delay after a region change before fetching DEM tiles. */
const DEBOUNCE_MS = 350;

export function useTerrainOverlays2D({
  mapRef,
  boundsVersion,
  active,
}: {
  mapRef: RefObject<MapRef | null>;
  boundsVersion: number;
  /** False while the 3D view (or anything else) makes 2D overlays moot. */
  active: boolean;
}): TerrainOverlays2D {
  const slopeOn = useSettingsStore((s) => s.terrainSlope);
  const contoursOn = useSettingsStore((s) => s.terrainContours);
  const intervalM = useSettingsStore((s) => s.terrainContourIntervalM);
  const slopeMinDeg = useSettingsStore((s) => s.terrainSlopeMinDeg);
  const slopeMaxDeg = useSettingsStore((s) => s.terrainSlopeMaxDeg);

  const [state, setState] = useState<TerrainOverlays2D>({
    slope: null,
    contours: null,
    error: null,
  });
  const reqIdRef = useRef(0);
  const coveredRef = useRef<string>('');

  const enabled = active && (slopeOn || contoursOn);

  useEffect(() => {
    if (!enabled) {
      // Invalidate the coverage key so re-enabling recomputes; the stale state
      // object is hidden by the `enabled` guard on the return value below.
      coveredRef.current = '';
      return;
    }
    const reqId = ++reqIdRef.current;
    const timer = setTimeout(() => {
      void (async () => {
        const view = await mapRef.current?.getViewState().catch(() => undefined);
        if (!view || reqId !== reqIdRef.current) return;
        const [w, s, e, n] = view.bounds as [number, number, number, number];
        const padLng = (e - w) * PAD;
        const padLat = (n - s) * PAD;
        const bounds = {
          minLng: w - padLng,
          minLat: s - padLat,
          maxLng: e + padLng,
          maxLat: n + padLat,
        };
        // Skip when the settled viewport and all knobs match the last compute.
        const key = [
          bounds.minLng.toFixed(4),
          bounds.minLat.toFixed(4),
          bounds.maxLng.toFixed(4),
          bounds.maxLat.toFixed(4),
          slopeOn,
          contoursOn,
          intervalM,
          slopeMinDeg,
          slopeMaxDeg,
        ].join('|');
        if (key === coveredRef.current) return;

        try {
          const hm = await fetchHeightmap(bounds, GRID);
          if (reqId !== reqIdRef.current) return;

          let slope: TerrainOverlays2D['slope'] = null;
          if (slopeOn) {
            const midLat = (hm.bbox.minLat + hm.bbox.maxLat) / 2;
            const mPerDegLat = 111320;
            const mPerDegLng = 111320 * Math.cos((midLat * Math.PI) / 180);
            const cellXm = ((hm.bbox.maxLng - hm.bbox.minLng) * mPerDegLng) / (GRID - 1);
            const cellZm = ((hm.bbox.maxLat - hm.bbox.minLat) * mPerDegLat) / (GRID - 1);
            const rgba = slopeOverlayRgba(hm.data, GRID, cellXm, cellZm, slopeMinDeg, slopeMaxDeg);
            const buf = rgba.buffer.slice(
              rgba.byteOffset,
              rgba.byteOffset + rgba.byteLength,
            ) as ArrayBuffer;
            const png = new Uint8Array(UPNG.encode([buf], GRID, GRID, 0));
            // Alternate between two file names: MapLibre caches by URL, so
            // rewriting one fixed path would keep showing the stale image.
            const uri = storage.writeOverlayPng(`slope2d-${reqId % 2}`, bytesToBase64(png));
            slope = {
              uri,
              coordinates: [
                [hm.bbox.minLng, hm.bbox.maxLat],
                [hm.bbox.maxLng, hm.bbox.maxLat],
                [hm.bbox.maxLng, hm.bbox.minLat],
                [hm.bbox.minLng, hm.bbox.minLat],
              ],
            };
          }

          const contours = contoursOn ? contourFeatures(hm, intervalM) : null;
          if (reqId !== reqIdRef.current) return;
          coveredRef.current = key;
          setState({ slope, contours, error: null });
        } catch (err) {
          if (reqId !== reqIdRef.current) return;
          coveredRef.current = '';
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
