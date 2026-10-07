import { canonicalize, type Json } from './canonical';
import { compareStamp, type Stamp } from './hlc';

/**
 * State-based CRDTs for team data (#589, deliverable 5). Every merge here is
 * commutative, associative and idempotent (property-tested in
 * `crdt.test.ts`), so replicas converge whatever order and however many times
 * they exchange state.
 *
 * The rules are Sync M0's (`@core/sync/merge.ts`), lifted from wall-clock
 * numbers to HLC {@link Stamp}s:
 * - newer stamp wins;
 * - a tombstone beats an edit with the same stamp (M0's "tombstone wins
 *   ties");
 * - an edit newer than the tombstone resurrects the record (M0's
 *   "resurrection by newer edit") — but only the fields written after the
 *   delete come back, so a resurrected waypoint never shows half its
 *   pre-delete fields.
 *
 * M0 compares whole items; here registers are per field, so two members
 * editing different fields of the same waypoint both keep their change.
 */

/** Last-writer-wins register. */
export interface Register<T extends Json = Json> {
  value: T;
  stamp: Stamp;
}

/**
 * Deterministic winner of two registers. Equal stamps can only come from one
 * author signing two different values for the same instant (equivocation);
 * the canonical text breaks that tie so every replica still agrees.
 */
export function mergeRegister<T extends Json>(a: Register<T>, b: Register<T>): Register<T> {
  const c = compareStamp(a.stamp, b.stamp);
  if (c !== 0) return c > 0 ? a : b;
  return (canonicalize(a.value) ?? '') >= (canonicalize(b.value) ?? '') ? a : b;
}

export function maxOf(a: Stamp | undefined, b: Stamp | undefined): Stamp | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return compareStamp(a, b) >= 0 ? a : b;
}

function minOf(a: Stamp | undefined, b: Stamp | undefined): Stamp | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return compareStamp(a, b) <= 0 ? a : b;
}

/** A record of LWW fields with an optional tombstone. */
export interface EntityState {
  fields: Record<string, Register>;
  /** Newest delete. */
  deleted?: Stamp;
  /** Oldest field write (→ `createdAt`); absent when only a delete is known. */
  created?: Stamp;
}

export function mergeEntity(a: EntityState, b: EntityState): EntityState {
  const fields: Record<string, Register> = { ...a.fields };
  for (const [name, reg] of Object.entries(b.fields)) {
    const mine = fields[name];
    fields[name] = mine === undefined ? reg : mergeRegister(mine, reg);
  }
  const out: EntityState = { fields };
  const created = minOf(a.created, b.created);
  if (created !== undefined) out.created = created;
  const deleted = maxOf(a.deleted, b.deleted);
  if (deleted !== undefined) out.deleted = deleted;
  return out;
}

/** Newest field write, if any. */
export function lastWrite(e: EntityState): Stamp | undefined {
  let top: Stamp | undefined;
  for (const reg of Object.values(e.fields)) top = maxOf(top, reg.stamp);
  return top;
}

/** Live = some field was written strictly after the newest delete. */
export function isLive(e: EntityState): boolean {
  const top = lastWrite(e);
  if (top === undefined) return false;
  return e.deleted === undefined || compareStamp(top, e.deleted) > 0;
}

/** The fields visible now: those written after the newest delete. */
export function visibleFields(e: EntityState): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [name, reg] of Object.entries(e.fields)) {
    if (e.deleted === undefined || compareStamp(reg.stamp, e.deleted) > 0) out[name] = reg.value;
  }
  return out;
}

/** A keyed collection of entities; merging is per key. */
export type EntityMap = ReadonlyMap<string, EntityState>;

export function mergeEntityMaps(a: EntityMap, b: EntityMap): Map<string, EntityState> {
  const out = new Map(a);
  for (const [key, e] of b) {
    const mine = out.get(key);
    out.set(key, mine === undefined ? e : mergeEntity(mine, e));
  }
  return out;
}

/** One `set` as a single-op entity state. */
export function setOp(fields: Record<string, Json>, stamp: Stamp): EntityState {
  return {
    fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { value: v, stamp }])),
    created: stamp,
  };
}

/** One `delete` as a single-op entity state. */
export function deleteOp(stamp: Stamp): EntityState {
  return { fields: {}, deleted: stamp };
}

/** Per-key LWW registers (shared positions: one register per member). */
export function mergeRegisterMaps<T extends Json>(
  a: ReadonlyMap<string, Register<T>>,
  b: ReadonlyMap<string, Register<T>>,
): Map<string, Register<T>> {
  const out = new Map(a);
  for (const [key, reg] of b) {
    const mine = out.get(key);
    out.set(key, mine === undefined ? reg : mergeRegister(mine, reg));
  }
  return out;
}
