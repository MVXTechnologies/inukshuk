import { nextStamp } from './clock';
import type { ReplicaView } from './merge';
import { enqueue, type Outbox, type OutboxEntry } from './outbox';
import { isSyncKind, itemKey, parseItemKey, type SyncKind } from './types';

/**
 * The device's persisted sync bookkeeping: per-item LWW stamps, tombstones
 * for propagating deletes, and the push outbox. Pure transitions only — the
 * store layer calls {@link recordUpsert} / {@link recordDelete} from every
 * library mutation, and the M2+ engine round-trips {@link replicaView} /
 * {@link applyMergedView} around `planMerge`.
 *
 * INTEGRATION NOTE (future `library.json` schema bump — owned by the schema-v5
 * team, deliberately NOT wired here): persisting this envelope requires adding
 * a single field to the library index, e.g. `sync: SyncState`, whose migration
 * seeds `emptySyncState()` and whose hydration runs {@link sanitizeSyncState}
 * over the raw value (the sanitizer is total, mirroring `migrations.ts`
 * discipline — junk in, usable state out). No per-item `updatedAt` fields on
 * `TrackSummary`/`Folder`/`Waypoint` are needed: stamps live here, keyed by
 * item id, which is what keeps this module standalone. The store adapter must
 * then (a) call `recordUpsert`/`recordDelete` in every mutation that
 * creates/edits/deletes a track, note photo, or the library-meta blob
 * (folders/waypoints/categories → one `libraryMeta` upsert), and (b) persist
 * the returned state alongside the index in the same atomic write.
 */
export interface SyncState {
  /** LWW stamp (`updatedAt`) per live item, keyed by `itemKey(kind, id)`. */
  stamps: Readonly<Record<string, number>>;
  /** `deletedAt` per deleted item awaiting propagation, keyed by `itemKey(kind, id)`. */
  tombstones: Readonly<Record<string, number>>;
  /** Pending pushes (see `outbox.ts`). */
  outbox: Outbox;
}

/** How long tombstones are retained before {@link pruneTombstones} may drop them. */
export const TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** The state of a device that has never recorded a syncable change. */
export function emptySyncState(): SyncState {
  return { stamps: {}, tombstones: {}, outbox: [] };
}

/** The newest stamp this device has ever recorded for the item, live or deleted. */
function lastStampOf(state: SyncState, key: string): number {
  return Math.max(state.stamps[key] ?? 0, state.tombstones[key] ?? 0);
}

/**
 * Record a local create/edit of an item: stamps it monotonically past anything
 * previously known for the item, clears any tombstone (an edit after a delete
 * is a resurrection), and enqueues the upsert for push.
 */
export function recordUpsert(state: SyncState, kind: SyncKind, id: string, now: number): SyncState {
  const key = itemKey(kind, id);
  const stamp = nextStamp(now, lastStampOf(state, key));
  const { [key]: _dropped, ...tombstones } = state.tombstones;
  return {
    stamps: { ...state.stamps, [key]: stamp },
    tombstones,
    outbox: enqueue(state.outbox, { kind, id, op: 'upsert', stamp }, now),
  };
}

/**
 * Record a local delete of an item: replaces its live stamp with a tombstone
 * stamped monotonically past it (so the delete beats the edit it follows even
 * across a backwards clock step), and enqueues the delete for push. Deleting
 * an item this device never stamped still tombstones it — the id may exist on
 * other devices.
 */
export function recordDelete(state: SyncState, kind: SyncKind, id: string, now: number): SyncState {
  const key = itemKey(kind, id);
  const stamp = nextStamp(now, lastStampOf(state, key));
  const { [key]: _dropped, ...stamps } = state.stamps;
  return {
    stamps,
    tombstones: { ...state.tombstones, [key]: stamp },
    outbox: enqueue(state.outbox, { kind, id, op: 'delete', stamp }, now),
  };
}

/** This device's {@link ReplicaView} of one collection, for `planMerge`. */
export function replicaView(state: SyncState, kind: SyncKind): ReplicaView {
  const pick = (stamps: Readonly<Record<string, number>>) => {
    const out: Record<string, number> = {};
    for (const [key, stamp] of Object.entries(stamps)) {
      const ref = parseItemKey(key);
      if (ref?.kind === kind) out[ref.id] = stamp;
    }
    return out;
  };
  return { live: pick(state.stamps), tombstones: pick(state.tombstones) };
}

/**
 * Write a post-merge converged view back for one collection, replacing that
 * collection's stamps and tombstones wholesale and leaving other kinds
 * untouched. The outbox is not modified — push entries settle individually as
 * the transport delivers them.
 */
export function applyMergedView(state: SyncState, kind: SyncKind, merged: ReplicaView): SyncState {
  const keep = (stamps: Readonly<Record<string, number>>) =>
    Object.fromEntries(Object.entries(stamps).filter(([key]) => parseItemKey(key)?.kind !== kind));
  const add = (stamps: Readonly<Record<string, number>>) =>
    Object.fromEntries(Object.entries(stamps).map(([id, s]) => [itemKey(kind, id), s]));
  return {
    stamps: { ...keep(state.stamps), ...add(merged.live) },
    tombstones: { ...keep(state.tombstones), ...add(merged.tombstones) },
    outbox: state.outbox,
  };
}

/**
 * Drop tombstones older than the retention window (default 90 days, matching
 * the planned server retention). A pruned tombstone can no longer veto a very
 * stale replica resurrecting the item — the accepted LWW trade-off; anything
 * still pending in the outbox is unaffected.
 */
export function pruneTombstones(
  state: SyncState,
  now: number,
  retentionMs = TOMBSTONE_RETENTION_MS,
): SyncState {
  const cutoff = now - retentionMs;
  const kept = Object.fromEntries(
    Object.entries(state.tombstones).filter(([, deletedAt]) => deletedAt >= cutoff),
  );
  if (Object.keys(kept).length === Object.keys(state.tombstones).length) return state;
  return { ...state, tombstones: kept };
}

// --- sanitization (total, mirroring src/core/library/migrations.ts) ---------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeStamps(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, stamp] of Object.entries(value)) {
    if (parseItemKey(key) === undefined) continue;
    if (typeof stamp !== 'number' || !Number.isFinite(stamp) || stamp <= 0) continue;
    out[key] = stamp;
  }
  return out;
}

function sanitizeOutbox(value: unknown): Outbox {
  const out: OutboxEntry[] = [];
  if (!Array.isArray(value)) return out;
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const { kind, id, op, stamp, enqueuedAt, attempts } = raw;
    if (!isSyncKind(kind) || typeof id !== 'string' || id === '') continue;
    if (op !== 'upsert' && op !== 'delete') continue;
    if (typeof stamp !== 'number' || !Number.isFinite(stamp) || stamp <= 0) continue;
    if (out.some((e) => e.kind === kind && e.id === id)) continue; // one entry per item
    out.push({
      kind,
      id,
      op,
      stamp,
      enqueuedAt: typeof enqueuedAt === 'number' && Number.isFinite(enqueuedAt) ? enqueuedAt : 0,
      attempts:
        typeof attempts === 'number' && Number.isInteger(attempts) && attempts > 0 ? attempts : 0,
    });
  }
  return out;
}

/**
 * Normalize a raw persisted sync envelope (any shape, or junk) to a usable
 * {@link SyncState}. Never throws: unknown fields are dropped, malformed keys,
 * stamps and outbox entries are discarded, and non-objects yield the empty
 * state — so a hand-edited or corrupt `library.json` never breaks hydration.
 */
export function sanitizeSyncState(raw: unknown): SyncState {
  if (!isRecord(raw)) return emptySyncState();
  return {
    stamps: sanitizeStamps(raw.stamps),
    tombstones: sanitizeStamps(raw.tombstones),
    outbox: sanitizeOutbox(raw.outbox),
  };
}
