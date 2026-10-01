/**
 * Viewport culling for the map's trail lines and personal heatmap (#494).
 *
 * The map builds GeoJSON only for what can be seen: the settled viewport
 * plus a margin (the "cull region"), at a simplification matched to the zoom.
 * The region is sticky — a camera settle that stays inside it at the same
 * integer zoom keeps it, and with it every source's identity, so a GPS
 * follow tick or a small pan never rebuilds (or re-uploads) anything.
 *
 * Pure.
 */

import { boxRects } from '@core/geo/bboxIndex';
import { simplifyIndices } from '@core/geo/track/simplify';
import type { BoundingBox } from '@core/models';
import { HEAT_CROSSFADE } from '@core/heat/heatStyle';

/** Margin added on each side of the viewport, as a fraction of its span. */
export const CULL_MARGIN = 0.5;

/** What the map builds for: a padded viewport at an integer zoom. */
export interface CullRegion {
  bounds: BoundingBox;
  /** `floor(zoom)` — the simplification and heat-layer bucket. */
  zoomLevel: number;
}

const WORLD: BoundingBox = { minLat: -90, minLng: -180, maxLat: 90, maxLng: 180 };

/** Longitude span of a box, antimeridian-aware (0..360). */
function lngSpan(b: BoundingBox): number {
  if (b.maxLng - b.minLng >= 360) return 360;
  return b.minLng <= b.maxLng ? b.maxLng - b.minLng : b.maxLng + 360 - b.minLng;
}

const wrapLng = (lng: number) => ((((lng + 180) % 360) + 360) % 360) - 180;

/**
 * `b` grown by `frac` of its span on each side. Latitude clamps at the poles;
 * a box that grows to the whole width of the world becomes [-180, 180], and
 * one that grows across the antimeridian wraps (`minLng > maxLng`).
 */
export function padBounds(b: BoundingBox, frac: number): BoundingBox {
  const f = Math.max(0, frac);
  const dLat = (b.maxLat - b.minLat) * f;
  const span = lngSpan(b);
  const minLat = Math.max(-90, b.minLat - dLat);
  const maxLat = Math.min(90, b.maxLat + dLat);
  if (span * (1 + 2 * f) >= 360) return { minLat, maxLat, minLng: -180, maxLng: 180 };
  const dLng = span * f;
  const west = b.minLng - dLng;
  const east = b.minLng + span + dLng;
  // Still inside [-180, 180]: no wrap.
  if (west >= -180 && east <= 180) return { minLat, maxLat, minLng: west, maxLng: east };
  return { minLat, maxLat, minLng: wrapLng(west), maxLng: wrapLng(east) };
}

/** Whether `inner` lies entirely inside `outer` (antimeridian-aware). */
export function containsBounds(outer: BoundingBox, inner: BoundingBox): boolean {
  if (inner.minLat < outer.minLat || inner.maxLat > outer.maxLat) return false;
  const outerSpan = lngSpan(outer);
  if (outerSpan >= 360) return true;
  const innerSpan = lngSpan(inner);
  if (innerSpan > outerSpan) return false;
  // Offset of inner's west edge east of outer's west edge, in [0, 360).
  const offset = (((inner.minLng - outer.minLng) % 360) + 360) % 360;
  return offset + innerSpan <= outerSpan;
}

/**
 * The region to build for after a camera settle: `prev` again (same object)
 * while the viewport is still inside it at the same integer zoom, otherwise
 * the viewport padded by {@link CULL_MARGIN}. Zooming far out lands on the
 * world box, which then contains every later viewport at that zoom.
 */
export function nextCullRegion(
  prev: CullRegion | null,
  viewport: BoundingBox,
  zoom: number,
  margin: number = CULL_MARGIN,
): CullRegion {
  const zoomLevel = Number.isFinite(zoom) ? Math.max(0, Math.floor(zoom)) : 0;
  if (prev && prev.zoomLevel === zoomLevel && containsBounds(prev.bounds, viewport)) return prev;
  const valid =
    Number.isFinite(viewport.minLat) &&
    Number.isFinite(viewport.maxLat) &&
    Number.isFinite(viewport.minLng) &&
    Number.isFinite(viewport.maxLng);
  return { bounds: valid ? padBounds(viewport, margin) : WORLD, zoomLevel };
}

/** Ground metres per screen pixel at the equator, at zoom 0 (512-px tiles, as MapLibre). */
const EQUATOR_M_PER_PX_Z0 = 40_075_016.686 / 512;
/** Below this, extra simplification is pointless: the stored geometry is ~4 m already. */
const MIN_EXTRA_TOLERANCE_M = 5;

/**
 * Extra simplification tolerance (metres) for trail lines drawn at a zoom
 * level: about a pixel at 45° latitude, so the line is indistinguishable
 * from the stored geometry. 0 at street zooms (no extra pass); hundreds of
 * metres when a whole region is on screen.
 */
export function lineToleranceM(zoomLevel: number): number {
  const tol = (EQUATOR_M_PER_PX_Z0 / Math.pow(2, Math.max(0, zoomLevel))) * Math.SQRT1_2;
  return tol < MIN_EXTRA_TOLERANCE_M ? 0 : Math.round(tol);
}

/**
 * Parts simplified to `toleranceM` (Douglas–Peucker); parts shorter than two
 * points are dropped. A tolerance of 0 returns `parts` itself.
 */
export function simplifyParts(
  parts: readonly [number, number][][],
  toleranceM: number,
): [number, number][][] {
  if (!(toleranceM > 0)) return parts.filter((p) => p.length >= 2);
  const out: [number, number][][] = [];
  for (const part of parts) {
    if (part.length < 2) continue;
    const pts = part.map(([longitude, latitude]) => ({ longitude, latitude }));
    const kept: [number, number][] = [];
    for (const i of simplifyIndices(pts, toleranceM)) {
      const p = part[i];
      if (p) kept.push([p[0], p[1]]);
    }
    if (kept.length >= 2) out.push(kept);
  }
  return out;
}

/** Which heat sources a zoom level draws (see the layers' min/max zooms). */
export function heatLayersAt(zoomLevel: number): { glow: boolean; lines: boolean } {
  return {
    // The glow layer's maxzoom is HEAT_CROSSFADE[1] (12.5): level 12 still draws it.
    glow: zoomLevel < Math.ceil(HEAT_CROSSFADE[1]),
    // The lines layer's minzoom is HEAT_CROSSFADE[0] - 1 (9).
    lines: zoomLevel >= Math.floor(HEAT_CROSSFADE[0] - 1),
  };
}

/** Most trail lines one region draws; beyond it the newest win (see {@link capNewest}). */
export const MAX_TRAIL_LINES = 600;
/**
 * Most trail-line coordinates one region sends to the map (~2.5 MB of
 * GeoJSON); beyond it the newest trails win and older ones wait for a
 * closer zoom.
 */
export const MAX_TRAIL_LINE_VERTICES = 120_000;

/**
 * At most `cap` of `ids`, newest first by `startedAt` when over the cap, and
 * in the original order otherwise (so sources keep a stable feature order).
 */
export function capNewest(
  ids: readonly string[],
  startedAt: (id: string) => number,
  cap: number = MAX_TRAIL_LINES,
): string[] {
  if (ids.length <= cap) return [...ids];
  const keep = new Set(
    [...ids]
      .map((id) => ({ id, at: startedAt(id) }))
      .sort((a, b) => b.at - a.at)
      .slice(0, Math.max(0, cap))
      .map((x) => x.id),
  );
  return ids.filter((id) => keep.has(id));
}

/** Vertices per chunk when clipping a line to a region (see {@link chunkParts}). */
export const LINE_CHUNK_VERTICES = 32;

/** A run of one part's vertices, `start..end` inclusive, with its box. */
export interface LineChunk {
  part: number;
  start: number;
  end: number;
  box: BoundingBox;
}

/** A box spanning more than this much longitude is taken to cross the antimeridian. */
const WRAP_SPAN_DEG = 180;

/**
 * Cut each part into chunks of at most `size` segments (neighbouring chunks
 * share their boundary vertex), each with its bounding box — computed once
 * per geometry, so clipping to a region is a box test per chunk. A chunk
 * that seems to span more than half the world (an antimeridian crossing) is
 * given the world box: it is never clipped away.
 */
export function chunkParts(
  parts: readonly (readonly (readonly [number, number])[])[],
  size: number = LINE_CHUNK_VERTICES,
): LineChunk[] {
  const step = Math.max(1, Math.floor(size));
  const chunks: LineChunk[] = [];
  parts.forEach((pts, part) => {
    for (let start = 0; start < pts.length - 1; start += step) {
      const end = Math.min(start + step, pts.length - 1);
      let minLng = Infinity;
      let minLat = Infinity;
      let maxLng = -Infinity;
      let maxLat = -Infinity;
      for (let i = start; i <= end; i++) {
        const p = pts[i];
        if (!p) continue;
        if (p[0] < minLng) minLng = p[0];
        if (p[0] > maxLng) maxLng = p[0];
        if (p[1] < minLat) minLat = p[1];
        if (p[1] > maxLat) maxLat = p[1];
      }
      const box =
        maxLng - minLng > WRAP_SPAN_DEG
          ? { minLat, maxLat, minLng: -180, maxLng: 180 }
          : { minLat, maxLat, minLng, maxLng };
      chunks.push({ part, start, end, box });
    }
  });
  return chunks;
}

/**
 * The pieces of `parts` whose chunks meet `bounds`: consecutive meeting
 * chunks of one part join into one polyline, so a trail that leaves the
 * region and comes back is two pieces, never a straight line across the gap.
 * A part kept whole is returned as-is (no copy).
 */
export function clipParts(
  parts: readonly [number, number][][],
  chunks: readonly LineChunk[],
  bounds: BoundingBox,
): [number, number][][] {
  const out: [number, number][][] = [];
  // Chunk boxes never wrap (see chunkParts); the region may: test its rects.
  const rects = boxRects(bounds);
  const meets = (b: BoundingBox) =>
    rects.some((r) => b.minLng <= r.e && r.w <= b.maxLng && b.minLat <= r.n && r.s <= b.maxLat);
  let run: { part: number; from: number; to: number } | null = null;
  const flush = () => {
    if (!run) return;
    const pts = parts[run.part];
    if (pts)
      out.push(run.from === 0 && run.to === pts.length - 1 ? pts : pts.slice(run.from, run.to + 1));
    run = null;
  };
  for (const c of chunks) {
    if (!meets(c.box)) {
      flush();
      continue;
    }
    if (run && run.part === c.part && run.to === c.start) run.to = c.end;
    else {
      flush();
      run = { part: c.part, from: c.start, to: c.end };
    }
  }
  flush();
  return out;
}

/** Coordinates in a set of parts. */
export function vertexCount(parts: readonly (readonly unknown[])[]): number {
  let n = 0;
  for (const p of parts) n += p.length;
  return n;
}
