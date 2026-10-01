/**
 * The personal heatmap, clipped to what the map can show (#494). The pass
 * grid is still built once per library change (its counts need every trail),
 * but what reaches MapLibre is only the part inside the cull region: the
 * pieces of pass-count chains that meet it, and the glow points inside it.
 *
 * `indexHeatLines` chunks every chain once per grid build (boxes included),
 * so a camera settle costs one box test per chunk — nothing is re-walked.
 *
 * Pure.
 */

import type { Feature, FeatureCollection, MultiLineString, Point } from 'geojson';

import { boxRects } from '@core/geo/bboxIndex';
import { chunkParts, clipParts, type LineChunk } from '@core/map/viewportCull';
import type { BoundingBox } from '@core/models';

import type { HeatGlowProps, HeatLineProps } from './heatGrid';

/** One pass bucket's chains, chunked for clipping. */
interface IndexedBucket {
  count: number;
  lines: [number, number][][];
  chunks: LineChunk[];
}

export interface IndexedHeatLines {
  buckets: IndexedBucket[];
}

/** `heatGridLines`' output, each chain chunked with boxes (see `chunkParts`). */
export function indexHeatLines(
  fc: FeatureCollection<MultiLineString, HeatLineProps>,
): IndexedHeatLines {
  const buckets: IndexedBucket[] = [];
  for (const f of fc.features) {
    const lines: [number, number][][] = [];
    for (const line of f.geometry.coordinates) {
      const pts: [number, number][] = [];
      for (const p of line) {
        const [lng, lat] = p;
        if (lng !== undefined && lat !== undefined) pts.push([lng, lat]);
      }
      if (pts.length >= 2) lines.push(pts);
    }
    buckets.push({ count: f.properties.count, lines, chunks: chunkParts(lines) });
  }
  return { buckets };
}

/**
 * The heat lines inside `bounds` (chains cut where they leave it), one
 * feature per non-empty pass bucket — the same shape and order as
 * `heatGridLines`.
 */
export function heatLinesWithin(
  index: IndexedHeatLines,
  bounds: BoundingBox,
): FeatureCollection<MultiLineString, HeatLineProps> {
  const features: Feature<MultiLineString, HeatLineProps>[] = [];
  for (const b of index.buckets) {
    const kept = clipParts(b.lines, b.chunks, bounds);
    if (kept.length > 0) {
      features.push({
        type: 'Feature',
        geometry: { type: 'MultiLineString', coordinates: kept },
        properties: { count: b.count },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

/** The glow points inside `bounds` (edges included, antimeridian-aware). */
export function glowWithin(
  fc: FeatureCollection<Point, HeatGlowProps>,
  bounds: BoundingBox,
): FeatureCollection<Point, HeatGlowProps> {
  const rects = boxRects(bounds);
  const features = fc.features.filter((f) => {
    const [lng, lat] = f.geometry.coordinates;
    if (lng === undefined || lat === undefined) return false;
    return rects.some((r) => lng >= r.w && lng <= r.e && lat >= r.s && lat <= r.n);
  });
  return { type: 'FeatureCollection', features };
}
