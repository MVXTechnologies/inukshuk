import type { Json } from '@core/team/canonical';
import { decodeLine } from '@core/team/polyline';

import { extentM, type Pt } from './geo';

/**
 * The finished drawing (#683): a logged `e.set` of the owned entity kind
 * `drw`, never a new envelope type (an older phone would refuse it and stall
 * the author's hash chain). The fold (`@core/team/records`, `authorizeRecord`)
 * validates it here, the way it validates a rally point:
 *
 * ```
 * e.set { k: 'drw', id, f: {
 *   sh: 'free' | 'arrow' | 'circle' | 'rect',
 *   g:  encoded polyline (1e5): free ≤ 500 points · arrow [tail, head] · circle [centre] · rect 4 corners
 *   r:  circle radius, m (circle only)
 *   c:  palette index 0–7 (COLOUR_COUNT) · w: 1|2|3 · d: dashed
 *   ht: 'fill'|'open'|'both', hs: 1|2|3 (arrow only)
 *   tx: note, ≤ 40 chars (optional; later an `e.set { tx }` alone, by the owner)
 *   x:  expiry, epoch ms, in (created, created + 4 h + 1 min], or null = never
 * } }
 * ```
 *
 * Inside the world and at most 50 km across; members only; at most 30 live
 * shapes per author (`liveDrawings`). Deleting is `e.del` (author or admin);
 * an Undo of "Clear mine" sets the same fields again, which revives the record.
 */

export const SHAPES = ['free', 'arrow', 'circle', 'rect'] as const;
export type ShapeKind = (typeof SHAPES)[number];
export const HEAD_TYPES = ['fill', 'open', 'both'] as const;
export type HeadType = (typeof HEAD_TYPES)[number];

export const MAX_NOTE_CHARS = 40;
export const MAX_FREE_POINTS = 500;
/** 500 points of at most 12 encoded characters each. */
export const MAX_GEOMETRY_CHARS = 6_000;
export const MAX_LIFE_MS = 4 * 60 * 60_000;
/** Slack on the 4 h ceiling for the author's clock between choosing and stamping. */
export const LIFE_SLACK_MS = 60_000;
export const MAX_EXTENT_M = 50_000;
export const MAX_LIVE_PER_AUTHOR = 30;
/**
 * Palette size on the wire (`c` is 0–7). A protocol constant, not the UI's
 * palette length: `@core/team` validates drawings through this module and must
 * not depend on UI modules, and a peer must never refuse a colour another
 * version sends. `record.test.ts` pins it to `MEMBER_COLORS.length`.
 */
export const COLOUR_COUNT = 8;

const FIELDS: readonly string[] = ['sh', 'g', 'r', 'c', 'w', 'd', 'ht', 'hs', 'tx', 'x'];
const has = (f: Record<string, Json>, k: string) => Object.prototype.hasOwnProperty.call(f, k);
const oneOf = <T>(list: readonly T[], v: unknown): v is T => list.includes(v as T);
/** A line width or head size: 1, 2 or 3. */
export type Level = 1 | 2 | 3;
const level = (v: unknown): v is Level => v === 1 || v === 2 || v === 3;

/** Whether `v` names a shape kind. */
export const isShapeKind = (v: unknown): v is ShapeKind => oneOf(SHAPES, v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A note: a string of at most {@link MAX_NOTE_CHARS} (empty clears it). */
export const validNote = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= MAX_NOTE_CHARS;

/** How many points each shape holds: [min, max]. */
const POINTS: Readonly<Record<ShapeKind, readonly [number, number]>> = {
  free: [2, MAX_FREE_POINTS],
  arrow: [2, 2],
  circle: [1, 1],
  rect: [4, 4],
};

/**
 * A shape's points, decoded and checked (count, world, ≤ 50 km across with
 * the radius), or null. `minFree` lets a stroke in progress hold one point.
 */
export function parseGeometry(sh: unknown, g: unknown, r: unknown, minFree = 2): Pt[] | null {
  if (!oneOf(SHAPES, sh) || typeof g !== 'string' || g.length > MAX_GEOMETRY_CHARS) return null;
  const [min0, max] = POINTS[sh];
  const min = sh === 'free' ? minFree : min0;
  const pts = decodeLine(g, max);
  if (pts === null || pts.length < min) return null;
  if (sh === 'circle') {
    return finite(r) && r > 0 && 2 * r <= MAX_EXTENT_M ? pts : null;
  }
  if (r !== undefined) return null;
  return extentM(pts) <= MAX_EXTENT_M ? pts : null;
}

/** A shape's style, typed. */
export interface ShapeStyle {
  c: number;
  w: Level;
  d: boolean;
  /** Arrows only (both). */
  ht?: HeadType;
  hs?: Level;
}

/** The style fields (colour, width, dash, and the arrow head, arrows only) typed, or null. */
export function parseStyle(f: Record<string, Json>): ShapeStyle | null {
  const { c, w, d } = f;
  if (typeof c !== 'number' || !Number.isInteger(c) || c < 0 || c >= COLOUR_COUNT) return null;
  if (!level(w) || typeof d !== 'boolean') return null;
  if (f['sh'] === 'arrow') {
    const { ht, hs } = f;
    return oneOf(HEAD_TYPES, ht) && level(hs) ? { c, w, d, ht, hs } : null;
  }
  return !has(f, 'ht') && !has(f, 'hs') ? { c, w, d } : null;
}

/** Whether the style fields are valid ({@link parseStyle}). */
export function validStyle(f: Record<string, Json>): boolean {
  return parseStyle(f) !== null;
}

/** `x`: null (never), or after the op's own time and at most 4 h (+ slack) after it. */
export function validExpiry(x: unknown, wall: number): boolean {
  if (x === null) return true;
  return (
    Number.isSafeInteger(x) &&
    (x as number) > wall &&
    (x as number) <= wall + MAX_LIFE_MS + LIFE_SLACK_MS
  );
}

/**
 * What a `drw` write is: `full` (a new or revived shape, every field), `note`
 * (only `tx`, on a live shape), or null when malformed. `wall` = the op's HLC wall.
 */
export function drawWrite(f: Record<string, Json>, wall: number): 'full' | 'note' | null {
  const keys = Object.keys(f);
  if (!keys.every((k) => FIELDS.includes(k))) return null;
  if (has(f, 'tx') && !validNote(f['tx'])) return null;
  if (keys.length === 1 && has(f, 'tx')) return 'note';
  if (!['sh', 'g', 'c', 'w', 'd', 'x'].every((k) => has(f, k))) return null;
  if (parseGeometry(f['sh'], f['g'], f['r']) === null) return null;
  if (!validStyle(f) || !validExpiry(f['x'], wall)) return null;
  return 'full';
}

/**
 * Live shapes in one author's index entry at time `wall` (the fold's
 * deterministic clock: the op's own stamp). Expired entries are pruned.
 */
export function liveDrawings(mine: Map<string, number | null> | undefined, wall: number): number {
  if (mine === undefined) return 0;
  for (const [id, x] of mine) if (x !== null && x <= wall) mine.delete(id);
  return mine.size;
}

// ── Capabilities ─────────────────────────────────────────────────────────────

/** The capability this version advertises: it draws live strokes (`pen`). */
export const PEN_CAP = 'pen';

/** The live-stroke protocol this version speaks (the claim's `v`). */
export const PEN_PROTOCOL = 1;
/** The claim's field holding the pen protocol version. */
export const CAP_VERSION = 'v';
/** The claim's field holding its expiry (wall ms). */
export const CAP_EXPIRES = 'x';

/**
 * `e.set { k: 'cap', id: <member id>, f: { pen: 1, v: 1, x: <expiry ms> } }`.
 * Every value is a non-negative safe integer (field names are already checked
 * by `parseSetBody`): 0/1 flags, the version and the expiry, so a later
 * version can add fields without this one refusing the record.
 */
export function validCapFields(f: Record<string, Json>): boolean {
  return Object.values(f).every((v) => Number.isSafeInteger(v) && (v as number) >= 0);
}
