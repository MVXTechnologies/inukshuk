import { isRecord, type Json } from '@core/team/canonical';
import { compareHlc, compareStamp, parseHlc, type Hlc, type Stamp } from '@core/team/hlc';
import { isMemberId } from '@core/team/ids';

/**
 * Conflict surfacing on top of per-field LWW (2.7.0, `docs/design/sync-layer.md`
 * §4.3). Pure and domain-generic: any domain that opts into base stamps
 * (`DomainPlugin.baseStamps`) writes the {@link BASE_FIELD} field in its
 * `e.set` bodies and reads conflicts back from here.
 *
 * The merge itself stays `mergeEntity` (newer stamp wins, per field), so every
 * phone shows the same value. What LWW forgets is the loser; this module
 * recovers it from the record's write history (the op log is the history).
 *
 * **Base stamps.** Each write carries, per author, the newest HLC of that
 * author's writes *to this record* that the writer had folded when it wrote:
 * `b: { <memberId>: [wall, counter], … }`. A phone receives an author's ops in
 * chain order, so that one stamp stands for every earlier write of theirs:
 *
 * > W2 **saw** W1 ⇔ W2 sorts after W1 and (same author, or `W2.b[W1.author] ≥ W1`).
 *
 * The writer's own author is implied (its chain), so it is never sent. This
 * is a per-record version vector: exact causality between the writes of one
 * record, at a few dozen bytes per distinct editor.
 *
 * **Conflict.** For one field, the *heads* are the writes to it no other
 * write to it saw. One head: no conflict. Several: they were made without
 * seeing each other. The LWW winner is always a head (anything that saw it
 * sorts after it); the other heads are the "other versions", listed until a
 * write that saw them lands (someone resolved or overrode the conflict: the
 * writer's view held both, so its base covers both).
 *
 * **Hostile bases.** A base is a claim by its signer. Claiming to have seen
 * more than it did only hides a conflict from the claimant's own edit, which
 * an editor can do anyway by overwriting; claims about writes that sort after
 * the claimant never count (the scan is in descending stamp order), so no
 * base can make a later write look seen.
 */

/** The reserved field of a base-stamped `e.set` (a body field name must start with a letter). */
export const BASE_FIELD = 'b';
/** Distinct authors a base names at most (the newest ones are kept). */
export const MAX_BASE_AUTHORS = 64;

/** Author → newest HLC of theirs (on this record) the writer had folded. */
export type Base = ReadonlyMap<string, Hlc>;

export const EMPTY_BASE: Base = new Map();

/** One accepted write to one record, as conflict detection sees it. */
export interface Write {
  /** The op id (ties between equal stamps break on it, as in the fold). */
  id: string;
  stamp: Stamp;
  /** The fields it wrote, without {@link BASE_FIELD} (`{}` for an `e.del`). */
  fields: Readonly<Record<string, Json>>;
  base: Base;
  /** An `e.del` (a tombstone, not a field write). */
  del?: boolean;
}

/** A wire base: an object of member id → `[wall, counter]`; anything else is malformed. */
export function parseBase(v: unknown): Base | undefined {
  if (!isRecord(v)) return undefined;
  const entries = Object.entries(v);
  if (entries.length > MAX_BASE_AUTHORS) return undefined;
  const out = new Map<string, Hlc>();
  for (const [author, h] of entries) {
    const hlc = parseHlc(h);
    if (!isMemberId(author) || hlc === undefined) return undefined;
    out.set(author, hlc);
  }
  return out;
}

/**
 * The base a new write by `me` should carry, from the writes of the record
 * this phone has folded: each other author's newest stamp. Keeps the
 * {@link MAX_BASE_AUTHORS} newest authors (a record edited by more people is
 * not expected; dropping the oldest can only surface a stale conflict, never
 * hide one).
 */
export function baseFrom(writes: Iterable<Pick<Write, 'stamp'>>, me: string): Base {
  const newest = new Map<string, Stamp>();
  for (const { stamp } of writes) {
    if (stamp.author === me) continue;
    const cur = newest.get(stamp.author);
    if (cur === undefined || compareHlc(stamp, cur) > 0) newest.set(stamp.author, stamp);
  }
  const kept = [...newest.values()].sort((a, b) => compareStamp(b, a)).slice(0, MAX_BASE_AUTHORS);
  return new Map(kept.map((s) => [s.author, { wall: s.wall, counter: s.counter }]));
}

/** The wire form of a base (keys sorted, so equal bases encode equally). */
export function baseToWire(base: Base): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const author of [...base.keys()].sort()) {
    const h = base.get(author)!;
    out[author] = [h.wall, h.counter];
  }
  return out;
}

/** The fold's total order on writes: stamp, then op id. */
export function compareWrites(a: Write, b: Write): number {
  return compareStamp(a.stamp, b.stamp) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Whether `later` saw `earlier` (see the module note). */
export function saw(later: Write, earlier: Write): boolean {
  if (compareWrites(later, earlier) <= 0) return false;
  if (later.stamp.author === earlier.stamp.author) return true;
  const h = later.base.get(earlier.stamp.author);
  return h !== undefined && compareHlc(h, earlier.stamp) >= 0;
}

/**
 * The writes no other write in `writes` saw, newest first. Linear in the
 * writes times their base sizes: a descending scan keeps, per author, the
 * newest of their stamps any later write claims (or whether they wrote
 * later themselves).
 */
export function heads(writes: readonly Write[]): Write[] {
  const sorted = [...writes].sort((a, b) => compareWrites(b, a));
  const wroteLater = new Set<string>();
  const seenUpTo = new Map<string, Hlc>();
  const out: Write[] = [];
  for (const w of sorted) {
    const a = w.stamp.author;
    const claim = seenUpTo.get(a);
    const seen = wroteLater.has(a) || (claim !== undefined && compareHlc(claim, w.stamp) >= 0);
    if (!seen) out.push(w);
    wroteLater.add(a);
    for (const [author, h] of w.base) {
      const cur = seenUpTo.get(author);
      if (cur === undefined || compareHlc(h, cur) > 0) seenUpTo.set(author, h);
    }
  }
  return out;
}

/** One version of a field. */
export interface Version {
  write: Write;
  value: Json;
}

/** A field written by several people without seeing each other. */
export interface FieldConflict {
  field: string;
  /** The LWW winner: what every phone shows ("Kept"). */
  kept: Version;
  /** The other versions, newest first ("Use this"). */
  others: Version[];
}

const has = (f: Readonly<Record<string, Json>>, k: string): boolean =>
  Object.prototype.hasOwnProperty.call(f, k);

/** The writes of each field (tombstones excluded), by field name. */
function byField(writes: readonly Write[], skip: ReadonlySet<string>): Map<string, Write[]> {
  const out = new Map<string, Write[]>();
  for (const w of writes) {
    if (w.del) continue;
    for (const f of Object.keys(w.fields)) {
      if (skip.has(f) || f === BASE_FIELD) continue;
      const list = out.get(f);
      if (list === undefined) out.set(f, [w]);
      else list.push(w);
    }
  }
  return out;
}

/**
 * The record's open conflicts, by field name. `skip`: fields the domain
 * resolves another way (a removal flag, say).
 */
export function conflicts(
  writes: readonly Write[],
  skip: ReadonlySet<string> = new Set(),
): FieldConflict[] {
  const out: FieldConflict[] = [];
  for (const [field, ws] of byField(writes, skip)) {
    if (ws.length < 2) continue;
    const top = heads(ws);
    if (top.length < 2) continue;
    const [kept, ...others] = top as [Write, ...Write[]];
    out.push({
      field,
      kept: { write: kept, value: kept.fields[field]! },
      others: others.map((write) => ({ write, value: write.fields[field]! })),
    });
  }
  return out.sort((a, b) => (a.field < b.field ? -1 : 1));
}

/** A concurrent write whose fields merged without a conflict ("also merged"). */
export interface SilentMerge {
  write: Write;
  fields: string[];
}

/**
 * Concurrent writes of the record (heads of the whole record) and the fields
 * each brought in that nobody else wrote concurrently: "Noé changed the icon,
 * Julie added a description, both kept". Empty unless at least two writes
 * were concurrent.
 */
export function silentMerges(
  writes: readonly Write[],
  skip: ReadonlySet<string> = new Set(),
): SilentMerge[] {
  const live = writes.filter((w) => !w.del);
  const top = heads(live);
  if (top.length < 2) return [];
  const conflicted = new Set(conflicts(live, skip).map((c) => c.field));
  const out: SilentMerge[] = [];
  for (const write of top) {
    const fields = Object.keys(write.fields)
      .filter((f) => f !== BASE_FIELD && !skip.has(f) && !conflicted.has(f))
      .sort();
    if (fields.length > 0) out.push({ write, fields });
  }
  return out;
}

/** How a domain reads one write's effect on the record's removal. */
export type Removal = 'remove' | 'restore' | undefined;

/** Edits a removal won over without its author having seen them ("delete beat your offline edit"). */
export interface BeatenEdits {
  /** The write that removed the record (the current removal state). */
  removal: Write;
  /** Edits concurrent with it, oldest first. */
  edits: Write[];
}

/**
 * Whether the record is removed by a write that never saw some edits, and
 * which. `removal` classifies each write (a removal flag, or an `e.del`). The
 * newest classified write decides the state; while it is a removal, every
 * unclassified write concurrent with it (neither saw the other) was beaten.
 * After a restore nothing is listed: the record is back, edits included.
 */
export function beatenEdits(
  writes: readonly Write[],
  removal: (w: Write) => Removal,
): BeatenEdits | undefined {
  let decider: Write | undefined;
  for (const w of writes) {
    if (removal(w) !== undefined && (decider === undefined || compareWrites(w, decider) > 0))
      decider = w;
  }
  if (decider === undefined || removal(decider) !== 'remove') return undefined;
  const r = decider;
  const edits = writes
    .filter((w) => removal(w) === undefined && !saw(r, w) && !saw(w, r))
    .sort(compareWrites);
  return edits.length === 0 ? undefined : { removal: r, edits };
}

/** Whether a body field set carries a base (the domain validates it with {@link parseBase}). */
export function hasBase(f: Readonly<Record<string, Json>>): boolean {
  return has(f, BASE_FIELD);
}
