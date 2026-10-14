import { memberColor } from '@core/teamui/colors';

import { fadeState, formatLeft } from './fade';
import { bearingDeg, circleRing, destination, haversineM, metresPerDp, type Pt } from './geo';
import type { LiveStroke } from './pen';
import { fullNotes, recencyBand, type DrawShape } from './view';

/**
 * The one GeoJSON source for team drawings (#683), `team-draw`, rebuilt by
 * this pure function. Polygons fill circles (64-gons) and rectangles; lines
 * draw every outline, shaft and stroke; points carry arrowheads, compact
 * pointers, author badges, notes and the live pen tip, each with its bearing.
 * No per-shape views, and a fixed set of layers filters on `k` (and `d`).
 *
 * Every feature carries `drw` (`owner:id`, the tap key), `c` (hex colour),
 * `op` (quantised opacity), `z` (recency band, 0 oldest … 5 newest).
 */
export const LIVE_OPACITY = 0.9;
/** An arrow whose shaft is shorter than this on screen becomes a fixed pointer. */
export const POINTER_DP = 32;
export const CIRCLE_SIDES = 64;

type Geometry =
  | { type: 'Point'; coordinates: Pt }
  | { type: 'LineString'; coordinates: Pt[] }
  | { type: 'Polygon'; coordinates: Pt[][] };

export type FeatureKind =
  'fill' | 'line' | 'head' | 'pointer' | 'badge' | 'note' | 'noteGlyph' | 'tip';

export interface DrawFeature {
  type: 'Feature';
  geometry: Geometry;
  properties: {
    k: FeatureKind;
    drw: string;
    c: string;
    op: number;
    z: number;
    /** Line width level 1–3 and dash (lines, fills' outlines). */
    w?: number;
    d?: boolean;
    /** Bearing, degrees (heads, pointers). */
    rot?: number;
    /** `head-fill` / `head-open` (heads). */
    icon?: string;
    /** Head size level 1–3. */
    s?: number;
    /** Badge, tip or note text. */
    t?: string;
    live?: boolean;
  };
}

export interface DrawFeatureCollection {
  type: 'FeatureCollection';
  features: DrawFeature[];
}

export interface DrawOptions {
  me?: string;
  /** The selected shape's key. */
  selected?: string;
  /** Initials for a member's badge. */
  initials?: (member: string) => string;
}

/** Where a shape's badge (and note) sits: the stroke's start, the arrow's tail, the circle's top. */
export function anchorOf(s: Pick<DrawShape, 'sh' | 'pts' | 'r'>): Pt {
  const first = s.pts[0]!;
  return s.sh === 'circle' ? destination(first, 0, s.r!) : first;
}

/** Whether an arrow is drawn as the compact pointer at this zoom band. */
export function isCompact(tail: Pt, head: Pt, zoomBand: number): boolean {
  const mid = (tail[1] + head[1]) / 2;
  return haversineM(tail, head) / metresPerDp(zoomBand, mid) < POINTER_DP;
}

function outline(s: Pick<DrawShape, 'sh' | 'pts' | 'r'>): Pt[] {
  if (s.sh === 'circle') return circleRing(s.pts[0]!, s.r!, CIRCLE_SIDES);
  if (s.sh === 'rect') return [...s.pts, s.pts[0]!];
  return [...s.pts];
}

type Props = DrawFeature['properties'];

function geometryFeatures(
  s: Pick<DrawShape, 'sh' | 'pts' | 'r' | 'w' | 'd' | 'ht' | 'hs'>,
  base: Props,
  zoomBand: number,
  out: DrawFeature[],
): void {
  const add = (geometry: Geometry, extra: Partial<Props>) =>
    out.push({ type: 'Feature', geometry, properties: { ...base, ...extra } });
  if (s.sh === 'arrow') {
    const [tail, head] = s.pts as [Pt, Pt];
    const rot = bearingDeg(tail, head);
    if (isCompact(tail, head, zoomBand)) {
      const mid: Pt = [(tail[0] + head[0]) / 2, (tail[1] + head[1]) / 2];
      add({ type: 'Point', coordinates: mid }, { k: 'pointer', rot, s: s.hs! });
      return;
    }
    add({ type: 'LineString', coordinates: [tail, head] }, { k: 'line', w: s.w, d: s.d });
    const icon = s.ht === 'open' ? 'head-open' : 'head-fill';
    add({ type: 'Point', coordinates: head }, { k: 'head', rot, icon, s: s.hs! });
    if (s.ht === 'both') {
      add(
        { type: 'Point', coordinates: tail },
        { k: 'head', rot: (rot + 180) % 360, icon, s: s.hs! },
      );
    }
    return;
  }
  const ring = outline(s);
  if (s.sh === 'circle' || s.sh === 'rect') {
    add({ type: 'Polygon', coordinates: [ring] }, { k: 'fill' });
  }
  if (ring.length >= 2)
    add({ type: 'LineString', coordinates: ring }, { k: 'line', w: s.w, d: s.d });
}

/**
 * The whole `team-draw` source at `now` (the replica's HLC) for `zoomBand`
 * (the integer zoom, recomputed on camera idle: the compact-pointer switch is
 * never a `["zoom"]` style expression). `shapes` oldest first, as
 * `teamShapes` returns them; `live` from `liveStrokes`.
 */
export function drawFeatures(
  shapes: readonly DrawShape[],
  live: readonly LiveStroke[],
  now: number,
  zoomBand: number,
  opts: DrawOptions = {},
): DrawFeatureCollection {
  const features: DrawFeature[] = [];
  const notes = fullNotes(shapes, opts.me, opts.selected);
  const initials = opts.initials ?? (() => '');
  shapes.forEach((s, i) => {
    const fade = fadeState(s, now);
    if (!fade.visible) return;
    const base: Props = {
      k: 'line',
      drw: s.key,
      c: memberColor(s.c),
      op: fade.opacity,
      z: recencyBand(i, shapes.length),
    };
    geometryFeatures(s, base, zoomBand, features);
    const at = anchorOf(s);
    const who = initials(s.owner);
    const t = fade.left === null ? who : `${who} · ${formatLeft(fade.left)}`;
    const point = (k: FeatureKind, extra: Partial<Props>) =>
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: at },
        properties: { ...base, k, ...extra },
      });
    point('badge', { t });
    if (s.tx.length > 0)
      point(notes.has(s.key) ? 'note' : 'noteGlyph', notes.has(s.key) ? { t: s.tx } : {});
  });
  for (const l of live) {
    const base: Props = {
      k: 'line',
      drw: `${l.author}:${l.id}`,
      c: memberColor(l.c),
      op: LIVE_OPACITY,
      z: 5,
      live: true,
    };
    geometryFeatures(l, base, zoomBand, features);
    const tip = l.sh === 'free' ? l.pts[l.pts.length - 1]! : anchorOf(l);
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: tip },
      properties: { ...base, k: 'tip', t: initials(l.author) },
    });
  }
  return { type: 'FeatureCollection', features };
}

/**
 * A cheap key of the quantised frame: the source is rebuilt (one `setShape`)
 * only when it changes.
 */
export function frameKey(
  shapes: readonly DrawShape[],
  live: readonly LiveStroke[],
  now: number,
  zoomBand: number,
  opts: DrawOptions = {},
): string {
  const parts: string[] = [String(zoomBand), opts.selected ?? ''];
  for (const s of shapes) {
    const f = fadeState(s, now);
    parts.push(`${s.key}|${s.tx}|${f.opacity}|${f.left ?? ''}`);
  }
  for (const l of live) parts.push(`${l.author}:${l.id}|${l.at}|${l.g.length}`);
  return parts.join(';');
}
