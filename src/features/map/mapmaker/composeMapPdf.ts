import { slopeOverlayRgba } from '@core/geo/terrainAnalysis';
import { contourFeatures } from '@core/geo/contours';
import { attachGeoViewport } from '@core/geo/geopdf/write';
import { clampTileRange, tileRangeForBbox } from '@core/geo/terrain';
import { layoutMadeMap, RASTER_LONG_EDGE_PX, type PageFormat } from '@core/mapmaker/layout';
import { pageProjector, projectLines, type PagePoint } from '@core/mapmaker/pageSpace';
import { cropRasterToBbox } from '@core/mapmaker/cropRaster';
import { formatGratLabel, graticuleForBbox } from '@core/mapmaker/graticule';
import { blendRgbaOver } from '@core/mapmaker/rasterDraw';
import type { Position } from 'geojson';
import type { BoundingBox, CornerCoordinates, LngLat } from '@core/models';
import type { TrailNetworkId } from '@core/geo/trailNetworks';
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
import { fetchBasemapTexture, fetchHeightmap, fetchTrailsTexture, type DrapeSource } from '../dem';

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
  /** Opacity of the slope shading layer, 0..1. */
  slopeOpacity: number;
  includeUserData: boolean;
  /** Marked-trail databases composited over the basemap (empty = none). */
  markedTrailsNetworks: TrailNetworkId[];
  markedTrailsOpacity: number;
  /** Lat/lng graticule with edge labels. */
  grid: boolean;
  /** Compass rose (true north; magnetic north too when declination known). */
  compass: boolean;
  /**
   * Magnetic declination at the region (degrees east-positive), from the
   * device compass at compose time; null = unknown, magnetic arrow omitted.
   */
  declinationDeg: number | null;
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
const BOTTOM_TEXT_OFFSET = 76;

const CONTOUR_MINOR = rgb(0.55, 0.35, 0.15);
const CONTOUR_MAJOR = rgb(0.45, 0.27, 0.1);
const TRACK_COLOR = rgb(0.85, 0.15, 0.15);
const INK = rgb(0.15, 0.15, 0.15);
const GRID_COLOR = rgb(0.25, 0.35, 0.55);

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
  onProgress('tiles', 0.7);
  await nextTask();
  const baseRaster = cropRasterToBbox(texture, range, drawBbox);
  for (const network of options.markedTrailsNetworks) {
    // Each checked trail database composited straight into the basemap
    // raster: the routes become part of the printed base image, under the
    // vector layers.
    const trails = await fetchTrailsTexture(range, network);
    if (handle.aborted) throw new Error('aborted');
    await nextTask();
    const trailsCrop = cropRasterToBbox(trails, range, drawBbox);
    if (trailsCrop.width === baseRaster.width && trailsCrop.height === baseRaster.height) {
      blendRgbaOver(baseRaster.data, trailsCrop.data, options.markedTrailsOpacity);
    }
  }
  onProgress('tiles', 1);

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
      opacity: options.slopeOpacity,
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

  // Lat/lng graticule: thin lines across the frame with coordinate labels
  // just inside the west and south edges — the paper-topo idiom.
  if (options.grid) {
    const grat = graticuleForBbox(drawBbox);
    const meridianLines: Position[][] = grat.meridians.map((lng) => [
      [lng, drawBbox.minLat],
      [lng, drawBbox.maxLat],
    ]);
    const parallelLines: Position[][] = grat.parallels.map((lat) => [
      [drawBbox.minLng, lat],
      [drawBbox.maxLng, lat],
    ]);
    strokeLines(projectLines(layout, [...meridianLines, ...parallelLines]), 0.35, GRID_COLOR);
    // Coordinate indications AROUND the border, quad-sheet style: longitudes
    // just below the bottom neatline, latitudes in the left margin beside
    // their parallel.
    const project = pageProjector(layout);
    for (const lng of grat.meridians) {
      const p = project([lng, drawBbox.minLat]);
      const label = formatGratLabel(lng, 'lng');
      page.drawText(label, {
        x: p.x - font.widthOfTextAtSize(label, 6) / 2,
        y: mapRect.y - 8,
        size: 6,
        font,
        color: INK,
      });
    }
    for (const lat of grat.parallels) {
      const p = project([drawBbox.minLng, lat]);
      const label = formatGratLabel(lat, 'lat');
      page.drawText(label, {
        x: mapRect.x - font.widthOfTextAtSize(label, 6) - 3,
        y: p.y - 2,
        size: 6,
        font,
        color: INK,
      });
    }
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

  // Classic black-and-white alternating scale bar (4 segments) with end
  // labels — the paper-topo idiom, replacing the plain line of v1.
  const barY = stripTop - 36;
  const bar = layout.scaleBar;
  const BAR_H = 5;
  const SEGMENTS = 4;
  const segW = bar.widthPt / SEGMENTS;
  for (let i = 0; i < SEGMENTS; i++) {
    page.drawRectangle({
      x: mapRect.x + i * segW,
      y: barY,
      width: segW,
      height: BAR_H,
      color: i % 2 === 0 ? INK : rgb(1, 1, 1),
      borderColor: INK,
      borderWidth: 0.6,
    });
  }
  page.drawText('0', { x: mapRect.x - 2, y: barY + BAR_H + 3, size: 7, font, color: INK });
  const halfLabel = bar.meters / 2 >= 1000 ? `${bar.meters / 2000} km` : `${bar.meters / 2} m`;
  page.drawText(halfLabel, {
    x: mapRect.x + bar.widthPt / 2 - font.widthOfTextAtSize(halfLabel, 7) / 2,
    y: barY + BAR_H + 3,
    size: 7,
    font,
    color: INK,
  });
  page.drawText(bar.label, {
    x: mapRect.x + bar.widthPt - font.widthOfTextAtSize(bar.label, 7) / 2,
    y: barY + BAR_H + 3,
    size: 7,
    font,
    color: INK,
  });
  page.drawText(`Scale 1:${layout.scaleDenom.toLocaleString('en-US')}`, {
    x: mapRect.x,
    y: barY - 12,
    size: 9,
    font,
    color: INK,
  });

  // Compass: true-north arrow, and the magnetic-north arrow splayed by the
  // declination captured from the device compass (labelled like a USGS quad).
  const nx = mapRect.x + mapRect.w - 20;
  if (options.compass) {
    const cy = stripTop - 30;
    const LEN = 22;
    page.pushOperators(
      pushGraphicsState(),
      setLineWidth(1),
      setStrokingColor(INK),
      moveTo(nx, cy),
      lineTo(nx, cy + LEN),
      stroke(),
      popGraphicsState(),
    );
    page.drawSvgPath('M 0 0 L 3 8 L 6 0 Z', { x: nx - 3, y: cy + LEN + 8, color: INK });
    page.drawText('N', {
      x: nx - 3,
      y: cy + LEN + 10,
      size: 8,
      font: bold,
      color: INK,
    });
    if (options.declinationDeg !== null) {
      const rad = (options.declinationDeg * Math.PI) / 180;
      const mx = nx + Math.sin(rad) * LEN;
      const my = cy + Math.cos(rad) * LEN;
      page.pushOperators(
        pushGraphicsState(),
        setLineWidth(0.8),
        setStrokingColor(rgb(0.4, 0.4, 0.4)),
        moveTo(nx, cy),
        lineTo(mx, my),
        stroke(),
        popGraphicsState(),
      );
      page.drawText('MN', { x: mx + 2, y: my - 2, size: 6.5, font, color: rgb(0.4, 0.4, 0.4) });
      const decLabel = `${Math.abs(options.declinationDeg).toFixed(1)}°${options.declinationDeg >= 0 ? 'E' : 'W'}`;
      page.drawText(decLabel, {
        x: nx - 34,
        y: cy - 2,
        size: 6.5,
        font,
        color: rgb(0.4, 0.4, 0.4),
      });
    }
  } else {
    // Plain north triangle when the rose is off (maps are always north-up).
    page.drawSvgPath('M 0 0 L 5 -14 L 10 0 Z', { x: nx - 5, y: stripTop - 16, color: INK });
    page.drawText('N', { x: nx - 3.5, y: stripTop - 30, size: 10, font: bold, color: INK });
  }

  // Footer: layers recipe + attribution + date.
  const parts: string[] = [];
  if (contourLines) parts.push(`Contours every ${effectiveIntervalM} m`);
  if (slopePng) parts.push(`Slope ${options.slopeMinDeg}–${options.slopeMaxDeg}°`);
  parts.push(options.basemap === 'satellite' ? 'Imagery © Esri' : 'Map © Esri');
  if (options.markedTrailsNetworks.length > 0) parts.push('Routes © Waymarked Trails');
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
