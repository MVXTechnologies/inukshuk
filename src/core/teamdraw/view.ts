import { isLive, visibleFields } from '@core/team/crdt';
import type { EntityRecord, TeamData } from '@core/team/data';

import type { Pt } from './geo';
import { parseGeometry, validStyle, type HeadType, type ShapeKind } from './record';

/**
 * The drawings to show (#683), read from the data fold. A shape is visible
 * while it is live (not deleted) and not expired against the **replica's HLC**
 * ({@link drawClock}), never the bare phone clock: a phone whose clock runs
 * slow cannot keep shapes too long.
 *
 * At most {@link MAX_DRAWN} are drawn (the newest). They are ordered oldest
 * first, so later features draw on top, and carry a recency band for the
 * symbol layer's sort key (bands, never a continuous key).
 */
export const MAX_DRAWN = 60;
export const RECENCY_BANDS = 6;
/** Notes shown in full: the newest few, plus your own and the selected one. */
export const NEWEST_NOTES = 3;

export interface DrawShape {
  /** `owner:id`: the tap key and the de-duplication key. */
  key: string;
  owner: string;
  id: string;
  sh: ShapeKind;
  pts: Pt[];
  r?: number;
  c: number;
  w: 1 | 2 | 3;
  d: boolean;
  ht?: HeadType;
  hs?: 1 | 2 | 3;
  /** The note ('' for none). */
  tx: string;
  /** HLC wall of the first write. */
  created: number;
  /** Expiry (epoch ms), null = never. */
  expires: number | null;
}

/** The clock drawings expire against: the replica's HLC (its clock and every stamp seen). */
export function drawClock(hlcWall: number, deviceNow: number): number {
  return Math.max(hlcWall, deviceNow);
}

/** One `drw` record as a shape, or null (not a drawing, deleted, or not displayable). */
export function shapeOf(rec: EntityRecord): DrawShape | null {
  if (rec.kind !== 'drw' || rec.owner === undefined || rec.state.created === undefined) return null;
  if (!isLive(rec.state)) return null;
  const f = visibleFields(rec.state);
  const pts = parseGeometry(f['sh'], f['g'], f['r']);
  if (pts === null || !validStyle(f)) return null;
  const x = f['x'];
  const shape: DrawShape = {
    key: `${rec.owner}:${rec.id}`,
    owner: rec.owner,
    id: rec.id,
    sh: f['sh'] as ShapeKind,
    pts,
    c: f['c'] as number,
    w: f['w'] as 1 | 2 | 3,
    d: f['d'] as boolean,
    tx: typeof f['tx'] === 'string' ? f['tx'] : '',
    created: rec.state.created.wall,
    expires: typeof x === 'number' ? x : null,
  };
  if (shape.sh === 'circle') shape.r = f['r'] as number;
  if (shape.sh === 'arrow') {
    shape.ht = f['ht'] as HeadType;
    shape.hs = f['hs'] as 1 | 2 | 3;
  }
  return shape;
}

const newerFirst = (a: DrawShape, b: DrawShape) =>
  b.created - a.created || (a.key < b.key ? -1 : 1);

/**
 * Every visible drawing at `now` (the {@link drawClock}), the newest
 * {@link MAX_DRAWN}, ordered oldest first (newest on top).
 */
export function teamShapes(data: TeamData, now: number): DrawShape[] {
  const out: DrawShape[] = [];
  for (const rec of data.entities.values()) {
    const s = shapeOf(rec);
    if (s !== null && (s.expires === null || s.expires > now)) out.push(s);
  }
  return out.sort(newerFirst).slice(0, MAX_DRAWN).reverse();
}

/** All of `owner`'s visible shapes (Clear mine, the alert's "Show"). */
export function shapesOf(shapes: readonly DrawShape[], owner: string): DrawShape[] {
  return shapes.filter((s) => s.owner === owner);
}

/** The recency band of the shape at `index` in an oldest-first list of `n`: 0 oldest … 5 newest. */
export function recencyBand(index: number, n: number): number {
  const fromNewest = n - 1 - index;
  return Math.max(0, RECENCY_BANDS - 1 - Math.floor((fromNewest * RECENCY_BANDS) / MAX_DRAWN));
}

/** Keys of the shapes whose note shows in full: the 3 newest, mine, and the selected one. */
export function fullNotes(
  shapes: readonly DrawShape[],
  me: string | undefined,
  selected: string | undefined,
): Set<string> {
  const out = new Set<string>();
  const newest = [...shapes].sort(newerFirst).slice(0, NEWEST_NOTES);
  for (const s of newest) out.add(s.key);
  for (const s of shapes) if (s.owner === me) out.add(s.key);
  if (selected !== undefined) out.add(selected);
  return out;
}
