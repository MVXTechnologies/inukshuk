/**
 * Keeping the stored heatmap in step with the library (#500): what to add
 * and take out, and when to write a batch. Pure.
 */

/**
 * The work that brings a store holding `stored` (id → revision hash) to
 * exactly `wanted`: trails to take out (gone, no longer counted, or edited)
 * and trails to put in (new, or edited — an edited trail is in both lists).
 * `wanted`'s order is kept for `add`, so callers can put the visible trails
 * first.
 */
export function diffHeat(
  stored: ReadonlyMap<string, { hash: string }>,
  wanted: ReadonlyMap<string, string>,
): { remove: string[]; add: string[] } {
  const remove: string[] = [];
  const add: string[] = [];
  for (const [id, t] of stored) {
    const want = wanted.get(id);
    if (want === undefined || want !== t.hash) remove.push(id);
  }
  for (const [id, hash] of wanted) {
    if (stored.get(id)?.hash !== hash) add.push(id);
  }
  return { remove, add };
}

export interface FlushState {
  /** Trails applied in memory but not written yet. */
  pending: number;
  /** Time since the oldest unwritten change (ms). */
  sinceFirstMs: number;
  /** How long the previous write took (ms; 0 before the first). */
  lastFlushMs: number;
}

export interface FlushPolicy {
  /** Write once this many trails are waiting… */
  maxBatch: number;
  /** …or this long after the first unwritten change (a quiet import ends here). */
  debounceMs: number;
  /**
   * Never write more often than this many times the last write's cost, so
   * writing takes at most ~1/(ratio+1) of a long rebuild however large the
   * store grows.
   */
  costRatio: number;
}

export const DEFAULT_FLUSH_POLICY: FlushPolicy = { maxBatch: 50, debounceMs: 2000, costRatio: 4 };

/**
 * Whether to write the pending batch now. Writes happen per `maxBatch`
 * trails or per `debounceMs`, whichever comes first, but never sooner than
 * `costRatio` × the previous write's cost after the batch began.
 */
export function flushDue(s: FlushState, policy: FlushPolicy = DEFAULT_FLUSH_POLICY): boolean {
  if (s.pending <= 0) return false;
  const floor = s.lastFlushMs * policy.costRatio;
  if (s.sinceFirstMs < floor) return false;
  return s.pending >= policy.maxBatch || s.sinceFirstMs >= policy.debounceMs;
}

/** How long to wait (ms) before a pending batch is due, with no new work arriving. */
export function flushWaitMs(s: FlushState, policy: FlushPolicy = DEFAULT_FLUSH_POLICY): number {
  if (s.pending <= 0) return Infinity;
  const due = Math.max(policy.debounceMs, s.lastFlushMs * policy.costRatio);
  return Math.max(0, due - s.sinceFirstMs);
}
