import { clampStamp, MAX_FUTURE_SKEW_MS } from './clock';

/**
 * The LWW merge engine (M0 — pure, id/stamp level). Single-user, few-devices
 * sync needs no vector clocks: per-item last-write-wins on `updatedAt`,
 * tombstones propagate deletes and win exact ties, and an edit newer than a
 * tombstone resurrects the item.
 *
 * The engine deliberately never touches item payloads or files — it compares
 * stamps and emits a {@link MergePlan} of item ids. The M2+ transport executes
 * the plan (download/upload/delete) and the store applies `merged` back as its
 * authoritative post-merge view; this is what keeps the engine pure and the
 * platform adapter thin.
 */

/** One replica's knowledge of a collection: live-item stamps and tombstones, by item id. */
export interface ReplicaView {
  /** `updatedAt` for each live item. */
  live: Readonly<Record<string, number>>;
  /** `deletedAt` for each deleted item whose tombstone is still retained. */
  tombstones: Readonly<Record<string, number>>;
}

/** What must happen, per item id, to converge both replicas. */
export interface MergePlan {
  /** Remote live copy won — download/replace the local item. */
  applyRemote: string[];
  /** Remote tombstone won — delete the local item (keep the tombstone). */
  deleteLocal: string[];
  /** Local live copy won — upload it (resurrects a remotely deleted item when needed). */
  pushLocal: string[];
  /** Local tombstone won — delete the item on the server. */
  pushDelete: string[];
  /** The converged view both replicas end up with once the plan is executed. */
  merged: ReplicaView;
}

/** An item is either live (stamped), deleted (tombstoned), or unknown to a replica. */
type ItemState =
  { state: 'live'; stamp: number } | { state: 'tombstone'; stamp: number } | { state: 'absent' };

const ABSENT: ItemState = { state: 'absent' };

/**
 * A replica's state for one id. A corrupt view listing an id as both live and
 * tombstoned resolves LWW-style within the replica: newer stamp wins, the
 * tombstone winning ties (deleting is the conservative read of that conflict).
 */
function itemState(view: ReplicaView, id: string): ItemState {
  const live = view.live[id];
  const dead = view.tombstones[id];
  if (live !== undefined && dead !== undefined) {
    return dead >= live ? { state: 'tombstone', stamp: dead } : { state: 'live', stamp: live };
  }
  if (live !== undefined) return { state: 'live', stamp: live };
  if (dead !== undefined) return { state: 'tombstone', stamp: dead };
  return ABSENT;
}

/**
 * Clamp every stamp in a replica view into the plausible window
 * `[0, now + maxFutureMs]` (see `clock.ts`). Run this over a view whose stamps
 * come from another device *before* merging, so a device with a runaway-fast
 * clock cannot produce stamps that win every merge for months. Within the
 * window, ordinary skew (minutes) is tolerated: plain LWW applies unchanged.
 */
export function clampReplicaView(
  view: ReplicaView,
  now: number,
  maxFutureMs = MAX_FUTURE_SKEW_MS,
): ReplicaView {
  const clampAll = (stamps: Readonly<Record<string, number>>) =>
    Object.fromEntries(
      Object.entries(stamps).map(([id, s]) => [id, clampStamp(s, now, maxFutureMs)]),
    );
  return { live: clampAll(view.live), tombstones: clampAll(view.tombstones) };
}

/**
 * Compute the LWW merge of one collection across two replicas.
 *
 * Rules, in order:
 * - newer stamp wins per item, whatever the states are;
 * - **exact tie across states → the tombstone wins** on both sides. A
 *   side-based tiebreak ("server wins") cannot work here: it resolves the
 *   same pair differently depending on which replica runs the merge, so the
 *   replicas never converge. State-based resolution is symmetric, and
 *   preferring the tombstone keeps a delete from silently resurrecting.
 *   (The server stays authoritative for same-stamp *payload* choice in M2+.)
 * - equal stamps in the *same* state are already converged: no action;
 * - an item only one side knows propagates to the other: local-only live →
 *   upload; remote-only live → download; local-only tombstone → push the
 *   delete (parking it server-side for other devices, and harmless if the
 *   server GC'd its copy); remote-only tombstone → adopt it locally with no
 *   action (there is nothing to delete).
 *
 * `merged` is symmetric: `planMerge(a, b).merged` equals `planMerge(b, a).merged`,
 * and executing the plan on both sides makes both replicas equal `merged` —
 * the convergence tests pin this down.
 */
export function planMerge(local: ReplicaView, remote: ReplicaView): MergePlan {
  const ids = new Set([
    ...Object.keys(local.live),
    ...Object.keys(local.tombstones),
    ...Object.keys(remote.live),
    ...Object.keys(remote.tombstones),
  ]);

  const applyRemote: string[] = [];
  const deleteLocal: string[] = [];
  const pushLocal: string[] = [];
  const pushDelete: string[] = [];
  const mergedLive: Record<string, number> = {};
  const mergedTombstones: Record<string, number> = {};

  for (const id of [...ids].sort()) {
    const l = itemState(local, id);
    const r = itemState(remote, id);

    if (l.state === 'absent' && r.state === 'absent') continue; // nothing to converge

    // Winner: newer stamp; on an exact cross-state tie the tombstone wins
    // (side-independent — see the contract above). Absent never beats a
    // stamped state. Same-state ties pick remote, which the in-sync /
    // both-deleted fast paths below turn into "no action".
    let winner: ItemState;
    if (l.state === 'absent') winner = r;
    else if (r.state === 'absent') winner = l;
    else if (l.stamp !== r.stamp) winner = l.stamp > r.stamp ? l : r;
    else if (l.state === r.state) winner = r;
    else winner = l.state === 'tombstone' ? l : r;
    // Absent never wins (the both-absent case was skipped above); this guard
    // only exists to narrow the type.
    if (winner.state === 'absent') continue;
    const remoteWon = winner === r;

    if (winner.state === 'live') {
      mergedLive[id] = winner.stamp;
      if (l.state === 'live' && r.state === 'live' && l.stamp === r.stamp) continue; // in sync
      if (remoteWon) applyRemote.push(id);
      else pushLocal.push(id);
    } else {
      mergedTombstones[id] = winner.stamp;
      if (l.state === 'tombstone' && r.state === 'tombstone') continue; // both deleted
      if (remoteWon) {
        // Only an actual local item needs deleting; adopting a tombstone for
        // an item we never had is pure bookkeeping.
        if (l.state === 'live') deleteLocal.push(id);
      } else {
        // Local tombstone wins — the server must delete its copy. Even when
        // the server has no copy, pushing the tombstone parks the deletion
        // server-side for other devices.
        pushDelete.push(id);
      }
    }
  }

  return {
    applyRemote,
    deleteLocal,
    pushLocal,
    pushDelete,
    merged: { live: mergedLive, tombstones: mergedTombstones },
  };
}
