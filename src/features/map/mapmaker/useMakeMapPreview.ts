import { contourFeatures } from '@core/geo/contours';
import { slopeOverlayRgba } from '@core/geo/terrainAnalysis';
import { clampTileRange, tileRangeForBbox } from '@core/geo/terrain';
import { cropRasterToBbox } from '@core/mapmaker/cropRaster';
import { graticuleForBbox } from '@core/mapmaker/graticule';
import { layoutMadeMap } from '@core/mapmaker/layout';
import { projectLines, type PagePoint } from '@core/mapmaker/pageSpace';
import { blendRgbaOver, drawPolylineRgba, type Rgba } from '@core/mapmaker/rasterDraw';
import { bytesToBase64 } from '@core/encoding/base64';
import type { BoundingBox } from '@core/models';
import type { Position } from 'geojson';
import { useEffect, useRef, useState } from 'react';
import UPNG from 'upng-js';
import { fetchBasemapTexture, fetchHeightmap, fetchTrailsTexture } from '../dem';
import type { MakeMapOptions } from './composeMapPdf';

/**
 * Live preview for the map-maker options sheet: a small raster composed with
 * the SAME sources and layer recipe as the final PDF — basemap tiles, marked
 * trails blend, slope shading with its chosen opacity, contour and grid
 * lines — so what you see is what prints. Returns a data-URI PNG plus the
 * live scale/contour numbers for the caption.
 *
 * Debounced and generation-guarded: toggling options mid-fetch abandons the
 * stale compose the same way the 2D overlay pipeline does.
 */

/** Long edge of the preview raster (px) — small enough to recompute freely. */
const DEBOUNCE_MS = 350;

export interface MakeMapPreview {
  /** data:image/png;base64 URI, or null while the first compose runs. */
  uri: string | null;
  width: number;
  height: number;
  /** Live caption facts. */
  scaleDenom: number;
  contourIntervalM: number;
  loading: boolean;
  error: string | null;
}

const PREVIEW_CONTOUR_MINOR: Rgba = [140, 90, 40, 200];
const PREVIEW_CONTOUR_MAJOR: Rgba = [115, 70, 26, 255];
const PREVIEW_GRID: Rgba = [64, 90, 140, 170];

export function useMakeMapPreview(bbox: BoundingBox, options: MakeMapOptions): MakeMapPreview {
  const [state, setState] = useState<MakeMapPreview>({
    uri: null,
    width: 3,
    height: 4,
    scaleDenom: 0,
    contourIntervalM: 0,
    loading: true,
    error: null,
  });
  const reqIdRef = useRef(0);

  // Only the option fields that change the picture participate in the key —
  // the map name must not retrigger composes on every keystroke.
  const key = [
    options.basemap,
    options.format,
    options.contours,
    options.contourIntervalM,
    options.slope,
    options.slopeMinDeg,
    options.slopeMaxDeg,
    options.slopeOpacity,
    options.markedTrails,
    options.markedTrailsOpacity,
    options.grid,
    bbox.minLng,
    bbox.minLat,
    bbox.maxLng,
    bbox.maxLat,
  ].join('|');

  useEffect(() => {
    const reqId = ++reqIdRef.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const layout = layoutMadeMap(bbox, options.format);
          const { drawBbox, mapRect } = layout;

          // Preview zoom: one level under print resolution — crisp on a phone
          // screen while the stitched range stays modest (≤6×6 tiles, cached
          // across recomputes since only the OPTIONS change, not the range).
          const zoom = Math.max(1, layout.rasterZoom - 1);
          const range = clampTileRange(tileRangeForBbox(drawBbox, zoom), 6);
          const texture = await fetchBasemapTexture(range, options.basemap);
          if (reqId !== reqIdRef.current) return;
          const raster = cropRasterToBbox(texture, range, drawBbox);
          // Line weights track the raster size so contours stay proportionate.
          const lineScale = Math.max(1, Math.round(raster.width / 500));

          if (options.markedTrails) {
            const trails = await fetchTrailsTexture(range);
            if (reqId !== reqIdRef.current) return;
            const crop = cropRasterToBbox(trails, range, drawBbox);
            if (crop.width === raster.width && crop.height === raster.height) {
              blendRgbaOver(raster.data, crop.data, options.markedTrailsOpacity);
            }
          }

          let contourIntervalM = 0;
          // Page-point → raster-pixel mapping (same projection as the PDF).
          const toPx = (p: PagePoint) => ({
            x: ((p.x - mapRect.x) / mapRect.w) * raster.width,
            y: (1 - (p.y - mapRect.y) / mapRect.h) * raster.height,
          });

          if (options.slope || options.contours) {
            const hm = await fetchHeightmap(drawBbox, 256);
            if (reqId !== reqIdRef.current) return;
            if (options.slope) {
              const midLat = (hm.bbox.minLat + hm.bbox.maxLat) / 2;
              const mPerDegLng = 111320 * Math.cos((midLat * Math.PI) / 180);
              const cellXm = ((hm.bbox.maxLng - hm.bbox.minLng) * mPerDegLng) / 255;
              const cellZm = ((hm.bbox.maxLat - hm.bbox.minLat) * 111320) / 255;
              const rgba = slopeOverlayRgba(
                hm.data,
                256,
                cellXm,
                cellZm,
                options.slopeMinDeg,
                options.slopeMaxDeg,
              );
              const crop = cropRasterToBbox(
                { data: rgba, width: 256, height: 256 },
                hm.range,
                drawBbox,
              );
              // The slope crop's grid differs from the preview raster's — blend
              // via nearest-neighbour resample into a raster-sized buffer.
              const scaled = new Uint8Array(raster.width * raster.height * 4);
              for (let y = 0; y < raster.height; y++) {
                const sy = Math.min(crop.height - 1, Math.floor((y / raster.height) * crop.height));
                for (let x = 0; x < raster.width; x++) {
                  const sx = Math.min(crop.width - 1, Math.floor((x / raster.width) * crop.width));
                  scaled.set(
                    crop.data.subarray((sy * crop.width + sx) * 4, (sy * crop.width + sx) * 4 + 4),
                    (y * raster.width + x) * 4,
                  );
                }
              }
              blendRgbaOver(raster.data, scaled, options.slopeOpacity);
            }
            if (options.contours) {
              const fc = contourFeatures(hm, options.contourIntervalM);
              contourIntervalM = fc.intervalM;
              const draw = (coords: Position[][], color: Rgba, thickness: number) => {
                for (const line of projectLines(layout, coords)) {
                  drawPolylineRgba(raster, line.map(toPx), color, thickness);
                }
              };
              draw(fc.minor.geometry.coordinates, PREVIEW_CONTOUR_MINOR, lineScale);
              draw(fc.major.geometry.coordinates, PREVIEW_CONTOUR_MAJOR, lineScale * 2);
            }
          }

          if (options.grid) {
            const grat = graticuleForBbox(drawBbox);
            const lines: Position[][] = [
              ...grat.meridians.map((lng): Position[] => [
                [lng, drawBbox.minLat],
                [lng, drawBbox.maxLat],
              ]),
              ...grat.parallels.map((lat): Position[] => [
                [drawBbox.minLng, lat],
                [drawBbox.maxLng, lat],
              ]),
            ];
            for (const line of projectLines(layout, lines)) {
              drawPolylineRgba(raster, line.map(toPx), PREVIEW_GRID, lineScale);
            }
          }

          if (reqId !== reqIdRef.current) return;
          const buf = raster.data.buffer.slice(0) as ArrayBuffer;
          const png = new Uint8Array(UPNG.encode([buf], raster.width, raster.height, 0));
          setState({
            uri: `data:image/png;base64,${bytesToBase64(png)}`,
            width: raster.width,
            height: raster.height,
            scaleDenom: layout.approxScaleDenom,
            contourIntervalM,
            loading: false,
            error: null,
          });
        } catch (err) {
          if (reqId !== reqIdRef.current) return;
          setState((s) => ({
            ...s,
            loading: false,
            error: err instanceof Error ? err.message : String(err),
          }));
        }
      })();
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // The key strings every picture-affecting input; options itself churns
    // identity per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
}
