import type { Json } from '@core/team/canonical';
import { isLive, lastWrite, own, visibleFields, type Register } from '@core/team/crdt';
import type { EntityRecord, TeamData } from '@core/team/data';
import { compareStamp, MAX_CLOCK_LEAD_MS } from '@core/team/hlc';

import type { Pt } from './geo';
import {
  LIFE_SLACK_MS,
  MAX_LIFE_MS,
  MAX_LIVE_PER_AUTHOR,
  isShapeKind,
  parseGeometry,
  parseStyle,
  type HeadType,
  type Level,
  type ShapeKind,
} from './record';

/**
 * The drawings to show (#683), read from the data fold. A shape is visible
 * while it is live (not deleted) and not expired against the **replica's HLC**
 * ({@link drawClock}), never the bare phone clock: a phone whose clock runs
 * slow cannot keep shapes too long.
 *
 * The fold judges each op at its own stamp (it has no other deterministic
 * clock), and a stamp may sit up to a day ahead (`MAX_FUTURE_SKEW_MS`). The
 * view knows the time, so it closes what the fold cannot (review #683):
 * - a shape written later than the clock's tolerated lead
 *   (`MAX_CLOCK_LEAD_MS`) is not shown yet, so batches stamped hours ahead
 *   never crowd out the present;
 * - a shape lives at most {@link MAX_SHOWN_LIFE_MS} after its first write,
 *   whatever its `x` says;
 * - a delete stamped before the shape's first write still deletes it (an
 *   admin's delete of a shape stamped ahead, once that shape becomes current);
 * - each author shows at most {@link MAX_LIVE_PER_AUTHOR}, and the
 *   {@link MAX_DRAWN} slots go round-robin between authors, newest first.
 *
 * Shapes are ordered oldest first, so later features draw on top, and carry
 * a recency band for the symbol layer's sort key (bands, never a continuous
 * key). Geometry is decoded only for shapes that make the cut, once per
 * written geometry ({@link drawViewWork} counts the decodes).
 */
export const MAX_DRAWN = 60;
export const RECENCY_BANDS = 6;
/** Notes shown in full: the newest few, plus your own and the selected one. */
export const NEWEST_NOTES = 3;
/** The longest a shape shows after its first write (4 h + the stamping slack). */
export const MAX_SHOWN_LIFE_MS = MAX_LIFE_MS + LIFE_SLACK_MS;

export interface DrawShape {
  /** `owner:id`: the tap key and the de-duplication key. */
  key: string;
  owner: string;
  id: string;
  sh: ShapeKind;
  /** Shared with the view's cache: never mutate. */
  pts: Pt[];
  r?: number;
  c: number;
  w: Level;
  d: boolean;
  ht?: HeadType;
  hs?: Level;
  /** The note ('' for none). */
  tx: string;
  /** HLC wall of the first write. */
  created: number;
  /** Expiry (epoch ms), null = never; at most {@link MAX_SHOWN_LIFE_MS} after `created`. */
  expires: number | null;
}

/** Work done by the view: the regression test counts geometry decodes. */
export const drawViewWork = { decodes: 0 };

/** The clock drawings expire against: the replica's HLC (its clock and every stamp seen). */
export function drawClock(hlcWall: number, deviceNow: number): number {
  return Math.max(hlcWall, deviceNow);
}

/** A record's cheap facts, read before any geometry is decoded. */
interface Head {
  rec: EntityRecord;
  owner: string;
  key: string;
  f: Record<string, Json>;
  created: number;
  /** HLC wall of the newest write. */
  latest: number;
  expires: number | null;
}

function headOf(rec: EntityRecord): Head | null {
  const st = rec.state;
  if (rec.kind !== 'drw' || rec.owner === undefined || st.created === undefined) return null;
  const top = lastWrite(st);
  if (top === undefined || !isLive(st)) return null;
  // A delete older than the first write was aimed at a shape stamped ahead.
  if (st.deleted !== undefined && compareStamp(st.deleted, st.created) < 0) return null;
  const f = visibleFields(st);
  const x = f['x'];
  const created = st.created.wall;
  return {
    rec,
    owner: rec.owner,
    key: `${rec.owner}:${rec.id}`,
    f,
    created,
    latest: top.wall,
    expires: typeof x === 'number' ? Math.min(x, created + MAX_SHOWN_LIFE_MS) : null,
  };
}

interface Decoded {
  sh: Json | undefined;
  r: Json | undefined;
  pts: Pt[] | null;
}

/** Decoded geometry per written `g` register: one decode per record and stamp. */
const geometryCache = new WeakMap<Register, Decoded>();

function geometryOf(h: Head): Pt[] | null {
  const { f } = h;
  if (typeof f['g'] !== 'string') return null;
  const reg = own(h.rec.state.fields, 'g');
  /* istanbul ignore if -- unreachable: f['g'] is that register's visible value */
  if (reg === undefined) return null;
  const hit = geometryCache.get(reg);
  if (hit !== undefined && hit.sh === f['sh'] && hit.r === f['r']) return hit.pts;
  drawViewWork.decodes++;
  const pts = parseGeometry(f['sh'], f['g'], f['r']);
  geometryCache.set(reg, { sh: f['sh'], r: f['r'], pts });
  return pts;
}

function build(h: Head): DrawShape | null {
  const { f, rec, owner } = h;
  const pts = geometryOf(h);
  const style = parseStyle(f);
  const sh = f['sh'];
  if (pts === null || style === null || !isShapeKind(sh)) return null;
  const shape: DrawShape = {
    key: h.key,
    owner,
    id: rec.id,
    sh,
    pts,
    ...style,
    tx: typeof f['tx'] === 'string' ? f['tx'] : '',
    created: h.created,
    expires: h.expires,
  };
  const r = f['r'];
  if (sh === 'circle' && typeof r === 'number') shape.r = r;
  return shape;
}

/**
 * One `drw` record as a shape, or null (not a drawing, deleted, or not
 * displayable). Time-free: {@link teamShapes} also checks expiry and lead.
 */
export function shapeOf(rec: EntityRecord): DrawShape | null {
  const h = headOf(rec);
  return h === null ? null : build(h);
}

type Dated = { created: number; key: string };
const newerFirst = (a: Dated, b: Dated) => b.created - a.created || (a.key < b.key ? -1 : 1);

interface Queue {
  list: Head[];
  /** `list[0]`, the author's newest. */
  newest: Head;
  next: number;
  taken: number;
}

/**
 * Every visible drawing at `now` (the {@link drawClock}): at most
 * {@link MAX_LIVE_PER_AUTHOR} per author and {@link MAX_DRAWN} in all, the
 * slots dealt round-robin between authors (each author's newest first,
 * authors in order of their newest), ordered oldest first (newest on top).
 */
export function teamShapes(data: TeamData, now: number): DrawShape[] {
  const byOwner = new Map<string, Head[]>();
  for (const rec of data.entities.values()) {
    const h = headOf(rec);
    if (h === null || h.latest > now + MAX_CLOCK_LEAD_MS) continue;
    if (h.expires !== null && h.expires <= now) continue;
    const list = byOwner.get(h.owner) ?? [];
    list.push(h);
    byOwner.set(h.owner, list);
  }
  let open: Queue[] = [...byOwner.values()].flatMap((list) => {
    const [newest] = list.sort(newerFirst);
    // A list is made with its first head: never empty.
    /* istanbul ignore next */
    if (newest === undefined) return [];
    return [{ list, newest, next: 0, taken: 0 }];
  });
  open.sort((a, b) => newerFirst(a.newest, b.newest));
  const out: DrawShape[] = [];
  while (out.length < MAX_DRAWN && open.length > 0) {
    for (const q of open) {
      if (out.length >= MAX_DRAWN) break;
      // The author's next displayable shape (a malformed one takes no slot).
      while (q.next < q.list.length) {
        const h = q.list[q.next++];
        /* istanbul ignore if -- unreachable: next < list.length */
        if (h === undefined) break;
        const s = build(h);
        if (s === null) continue;
        out.push(s);
        q.taken++;
        break;
      }
    }
    open = open.filter((q) => q.next < q.list.length && q.taken < MAX_LIVE_PER_AUTHOR);
  }
  return out.sort(newerFirst).reverse();
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
