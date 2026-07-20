import { slopeOverlayRgba } from '@core/geo/terrainAnalysis';
import { contourFeatures } from '@core/geo/contours';
import { attachGeoViewport } from '@core/geo/geopdf/write';
import { clampTileRange, tileRangeForBbox } from '@core/geo/terrain';
import { layoutMadeMap, RASTER_LONG_EDGE_PX, type PageFormat } from '@core/mapmaker/layout';
import { pageProjector, projectLines, type PagePoint } from '@core/mapmaker/pageSpace';
import { cropRasterToBbox } from '@core/mapmaker/cropRaster';
import type { BoundingBox, CornerCoordinates, LngLat } from '@core/models';
import { Buffer } from 'buffer';
import jpeg from 'jpeg-js';
import {
  PDFDocument,
  StandardFonts,
  rgb,
  pushGraphicsState,
  popGraphicsState,
  moveTo,
  lineTo,
  stroke,
  setLineWidth,
  setStrokingColor,
  setLineCap,
  LineCapStyle,
} from 'pdf-lib';
import UPNG from 'upng-js';
import { fetchBasemapTexture, fetchHeightmap, type DrapeSource } from '../dem';

// jpeg-js's ENCODER returns `Buffer.from(...)` whenever `module` is defined
// (always, under Metro) — Hermes has no Buffer global, so provide one before
// the first encode. The decoder (used by dem.ts) never needed it.
declare const global: { Buffer?: typeof Buffer };
if (typeof global.Buffer === 'undefined') global.Buffer = Buffer;

/**
 * Compose a made map into a georeferenced PDF (bytes). Pure-JS end to end:
 * basemap tiles (cache-first, same fetcher as the 3D drape) stitched, cropped
 * and embedded as JPEG; slope shading as a translucent PNG; contours, tracks
 * and waypoints drawn as vectors; margin strip with title, scale bar, north
 * arrow and attribution; and an ISO 32000 GEO viewport so the file imports
 * (here and in other apps) as a real GeoPDF.
 */

export interface MakeMapOptions {
  name: string;
  format: PageFormat;
  basemap: DrapeSource;
  contours: boolean;
  contourIntervalM: number;
  slope: boolean;
  slopeMinDeg: number;
  slopeMaxDeg: number;
  includeUserData: boolean;
}

export interface ComposeInput {
  bbox: BoundingBox;
  options: MakeMapOptions;
  /** Saved tracks intersecting the region (pre-filtered by the caller). */
  tracks: { name: string; points: LngLat[] }[];
  /** Saved waypoints in the region, numbered as their pins are on the map. */
  waypoints: { index: number; pos: LngLat }[];
}

export type ComposePhase = 'tiles' | 'terrain' | 'compose';

export interface ComposeHandle {
  aborted: boolean;
}

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Strip characters WinAnsi (CP1252) can't encode — pdf-lib's standard-14
 * fonts throw mid-compose otherwise ("WinAnsi cannot encode ..."), which is
 * exactly how "≈" in the scale label killed every make until E2E caught it.
 * Applied to every string drawn with a standard font (the user-typed map
 * name above all).
 */
const winAnsiSafe = (s: string) =>
  s.replace(/[^\x20-\x7E\xA0-\xFF€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/g, '');

/** Distance from the frame's bottom edge down to the footer baseline. */
const BOTTOM_TEXT_OFFSET = 62;

const CONTOUR_MINOR = rgb(0.55, 0.35, 0.15);
const CONTOUR_MAJOR = rgb(0.45, 0.27, 0.1);
const TRACK_COLOR = rgb(0.85, 0.15, 0.15);
const INK = rgb(0.15, 0.15, 0.15);

export async function composeMapPdf(
  input: ComposeInput,
  onProgress: (phase: ComposePhase, frac: number) => void,
  handle: ComposeHandle = { aborted: false },
): Promise<Uint8Array> {
  const { bbox, options } = input;
  const layout = layoutMadeMap(bbox, options.format);
  const { mapRect, drawBbox } = layout;

  // --- basemap raster ------------------------------------------------------
  onProgress('tiles', 0);
  const range = clampTileRange(
    tileRangeForBbox(drawBbox, layout.rasterZoom),
    RASTER_LONG_EDGE_PX / 256,
  );
  const texture = await fetchBasemapTexture(range, options.basemap);
  if (handle.aborted) throw new Error('aborted');
  onProgress('tiles', 1);
  await nextTask();
  const baseRaster = cropRasterToBbox(texture, range, drawBbox);

  // --- terrain layers ------------------------------------------------------
  let slopePng: Uint8Array | null = null;
  let contourLines: { minor: PagePoint[][]; major: PagePoint[][] } | null = null;
  let effectiveIntervalM = 0;
  if (options.slope || options.contours) {
    onProgress('terrain', 0);
    const hm = await fetchHeightmap(drawBbox, 256);
    if (handle.aborted) throw new Error('aborted');
    await nextTask();
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
      await nextTask();
      // The heightmap covers its own tile-aligned bbox; crop the slope image
      // to the drawn frame the same way the basemap is cropped.
      const slopeCrop = cropRasterToBbox(
        { data: rgba, width: 256, height: 256 },
        hm.range,
        drawBbox,
      );
      const buf = slopeCrop.data.buffer.slice(0) as ArrayBuffer;
      slopePng = new Uint8Array(UPNG.encode([buf], slopeCrop.width, slopeCrop.height, 0));
    }
    if (options.contours) {
      await nextTask();
      const fc = contourFeatures(hm, options.contourIntervalM);
      effectiveIntervalM = fc.intervalM;
      contourLines = {
        minor: projectLines(layout, fc.minor.geometry.coordinates),
        major: projectLines(layout, fc.major.geometry.coordinates),
      };
    }
    onProgress('terrain', 1);
  }
  if (handle.aborted) throw new Error('aborted');

  // --- page assembly -------------------------------------------------------
  onProgress('compose', 0);
  await nextTask();
  const doc = await PDFDocument.create();
  doc.setTitle(options.name);
  doc.setProducer('Inukshuk');
  const page = doc.addPage([layout.page.widthPt, layout.page.heightPt]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const baseJpg = jpeg.encode(
    { data: baseRaster.data, width: baseRaster.width, height: baseRaster.height },
    82,
  );
  const baseImage = await doc.embedJpg(baseJpg.data);
  page.drawImage(baseImage, { x: mapRect.x, y: mapRect.y, width: mapRect.w, height: mapRect.h });
  await nextTask();

  if (slopePng) {
    const slopeImage = await doc.embedPng(slopePng);
    page.drawImage(slopeImage, {
      x: mapRect.x,
      y: mapRect.y,
      width: mapRect.w,
      height: mapRect.h,
      opacity: 0.55,
    });
  }

  const strokeLines = (lines: PagePoint[][], width: number, color: ReturnType<typeof rgb>) => {
    if (lines.length === 0) return;
    const ops = [
      pushGraphicsState(),
      setLineWidth(width),
      setStrokingColor(color),
      setLineCap(LineCapStyle.Round),
    ];
    for (const line of lines) {
      ops.push(moveTo(line[0]!.x, line[0]!.y));
      for (let i = 1; i < line.length; i++) ops.push(lineTo(line[i]!.x, line[i]!.y));
      ops.push(stroke());
    }
    ops.push(popGraphicsState());
    page.pushOperators(...ops);
  };

  if (contourLines) {
    strokeLines(contourLines.minor, 0.4, CONTOUR_MINOR);
    strokeLines(contourLines.major, 0.9, CONTOUR_MAJOR);
    await nextTask();
  }

  if (options.includeUserData) {
    const project = pageProjector(layout);
    for (const track of input.tracks) {
      strokeLines(projectLines(layout, [track.points]), 2, TRACK_COLOR);
    }
    for (const wp of input.waypoints) {
      const p = project(wp.pos);
      if (
        p.x < mapRect.x ||
        p.x > mapRect.x + mapRect.w ||
        p.y < mapRect.y ||
        p.y > mapRect.y + mapRect.h
      )
        continue;
      page.drawCircle({
        x: p.x,
        y: p.y,
        size: 6,
        color: rgb(1, 1, 1),
        borderColor: TRACK_COLOR,
        borderWidth: 1.5,
      });
      const label = String(wp.index);
      const tw = bold.widthOfTextAtSize(label, 7);
      page.drawText(label, { x: p.x - tw / 2, y: p.y - 2.5, size: 7, font: bold, color: INK });
    }
    await nextTask();
  }

  // Frame border.
  page.drawRectangle({
    x: mapRect.x,
    y: mapRect.y,
    width: mapRect.w,
    height: mapRect.h,
    borderColor: INK,
    borderWidth: 1,
  });

  // --- margin strip --------------------------------------------------------
  const stripTop = mapRect.y - 10;
  const title = winAnsiSafe(options.name).trim() || 'My map';
  page.drawText(title, { x: mapRect.x, y: stripTop - 14, size: 14, font: bold, color: INK });

  // Scale bar with end ticks and the approx print scale.
  const barY = stripTop - 34;
  const bar = layout.scaleBar;
  page.pushOperators(
    pushGraphicsState(),
    setLineWidth(1.2),
    setStrokingColor(INK),
    moveTo(mapRect.x, barY),
    lineTo(mapRect.x + bar.widthPt, barY),
    stroke(),
    moveTo(mapRect.x, barY - 3),
    lineTo(mapRect.x, barY + 3),
    stroke(),
    moveTo(mapRect.x + bar.widthPt, barY - 3),
    lineTo(mapRect.x + bar.widthPt, barY + 3),
    stroke(),
    popGraphicsState(),
  );
  page.drawText(bar.label, {
    x: mapRect.x + bar.widthPt + 6,
    y: barY - 3,
    size: 9,
    font,
    color: INK,
  });
  page.drawText(`Scale 1:${layout.approxScaleDenom.toLocaleString('en-US')}`, {
    x: mapRect.x,
    y: barY - 16,
    size: 9,
    font,
    color: INK,
  });

  // North arrow (maps are always north-up): triangle + N at the right edge.
  const nx = mapRect.x + mapRect.w - 16;
  page.drawSvgPath('M 0 0 L 5 -14 L 10 0 Z', {
    x: nx - 5,
    y: stripTop - 16,
    color: INK,
  });
  page.drawText('N', { x: nx - 3.5, y: stripTop - 30, size: 10, font: bold, color: INK });

  // Footer: layers recipe + attribution + date.
  const parts: string[] = [];
  if (contourLines) parts.push(`Contours every ${effectiveIntervalM} m`);
  if (slopePng) parts.push(`Slope ${options.slopeMinDeg}–${options.slopeMaxDeg}°`);
  parts.push(options.basemap === 'satellite' ? 'Imagery © Esri' : 'Map © Esri');
  parts.push(`Made with Inukshuk · ${new Date().toISOString().slice(0, 10)}`);
  page.drawText(parts.join('  ·  '), {
    x: mapRect.x,
    y: mapRect.y - BOTTOM_TEXT_OFFSET,
    size: 7.5,
    font,
    color: rgb(0.35, 0.35, 0.35),
  });

  // --- georeference the frame ---------------------------------------------
  const corners: CornerCoordinates = {
    topLeft: [drawBbox.minLng, drawBbox.maxLat],
    topRight: [drawBbox.maxLng, drawBbox.maxLat],
    bottomRight: [drawBbox.maxLng, drawBbox.minLat],
    bottomLeft: [drawBbox.minLng, drawBbox.minLat],
  };
  attachGeoViewport(doc, page, mapRect, corners);

  const bytes = await doc.save();
  onProgress('compose', 1);
  return bytes;
}
