import type { SyncKind } from './types';

/**
 * The persisted push queue: which items have local changes the server hasn't
 * acknowledged yet. Pure reducers over an immutable array — the M1+ transport
 * walks pending entries with backoff (modeled on `src/data/errorQueue.ts`) and
 * settles them on acknowledgement; the store layer enqueues on every mutation.
 *
 * Invariants the reducers maintain:
 * - at most **one entry per item** (later changes coalesce into it);
 * - an entry always carries the **newest known stamp** for the item, so an
 *   acknowledgement for an older upload never drops a change that raced in
 *   while the upload was in flight;
 * - FIFO order by first enqueue is preserved across coalescing.
 */

/** What the transport must do for the item: upload its current state, or delete it. */
export type OutboxOp = 'upsert' | 'delete';

/** One pending item in the outbox. */
export interface OutboxEntry {
  kind: SyncKind;
  id: string;
  op: OutboxOp;
  /** LWW stamp (`updatedAt` / `deletedAt`) of the newest change this entry carries. */
  stamp: number;
  /** When the item first became dirty (epoch ms) — drives "pending since" UI, not ordering. */
  enqueuedAt: number;
  /** Failed delivery attempts so far; the transport derives backoff from this. */
  attempts: number;
}

/** The outbox is an append-coalesce queue, oldest dirty item first. */
export type Outbox = readonly OutboxEntry[];

/** A local mutation to record: what happened to which item, stamped with its LWW stamp. */
export interface OutboxChange {
  kind: SyncKind;
  id: string;
  op: OutboxOp;
  stamp: number;
}

function sameItem(entry: OutboxEntry, kind: SyncKind, id: string): boolean {
  return entry.kind === kind && entry.id === id;
}

/**
 * Record a local change. New items append; an existing entry for the same item
 * coalesces — the newer stamp wins, the op is replaced (upsert→delete when the
 * item is deleted, delete→upsert when it is recreated), and `attempts` resets
 * because the pending payload is now a different change. Re-recording the very
 * same change (same op + stamp) is a no-op, so replaying a mutation log into
 * the outbox is idempotent. Stale changes (older stamp than the entry) are
 * ignored.
 */
export function enqueue(outbox: Outbox, change: OutboxChange, now: number): Outbox {
  const index = outbox.findIndex((e) => sameItem(e, change.kind, change.id));
  if (index === -1) {
    return [
      ...outbox,
      {
        kind: change.kind,
        id: change.id,
        op: change.op,
        stamp: change.stamp,
        enqueuedAt: now,
        attempts: 0,
      },
    ];
  }
  const existing = outbox[index]!;
  if (change.stamp < existing.stamp) return outbox;
  if (change.stamp === existing.stamp && change.op === existing.op) return outbox;
  const next = [...outbox];
  // Keep the original enqueuedAt: the item has been continuously dirty since then.
  next[index] = { ...existing, op: change.op, stamp: change.stamp, attempts: 0 };
  return next;
}

/** Count one failed delivery attempt against an item's entry (no-op if absent). */
export function recordAttempt(outbox: Outbox, kind: SyncKind, id: string): Outbox {
  const index = outbox.findIndex((e) => sameItem(e, kind, id));
  if (index === -1) return outbox;
  const next = [...outbox];
  next[index] = { ...next[index]!, attempts: next[index]!.attempts + 1 };
  return next;
}

/**
 * The server acknowledged the item at `ackedStamp`. The entry is settled
 * (removed) only when it carries nothing newer — if a change raced in while
 * the upload was in flight, the entry (with its newer stamp) stays queued and
 * the newer change ships on the next pass. Settling twice, or settling an
 * unknown item, is a no-op — replays are harmless.
 */
export function settle(outbox: Outbox, kind: SyncKind, id: string, ackedStamp: number): Outbox {
  const index = outbox.findIndex((e) => sameItem(e, kind, id));
  if (index === -1 || outbox[index]!.stamp > ackedStamp) return outbox;
  return outbox.filter((_, i) => i !== index);
}
