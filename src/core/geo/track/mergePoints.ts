import type { TrackPoint } from '@core/models';

/**
 * Pure merge of background-journaled GPS fixes into an in-memory track.
 *
 * While the app is backgrounded, the OS-level location task may journal fixes
 * to disk (the JS process can be killed and relaunched headless). When the app
 * foregrounds — or a crashed recording is recovered — those journaled points
 * must be folded into the live point list without double-counting fixes that
 * the foreground watch already delivered. Identity is the fix timestamp: two
 * deliveries of the same GPS fix share `time` exactly.
 */

/** Gate applied to each merged-in point against the point that precedes it. */
export type AcceptFix = (prev: TrackPoint | undefined, next: TrackPoint) => boolean;

export interface MergeTrackPointsOptions {
  /**
   * Acceptance gate for INCOMING points only (base points are already vetted).
   * Called with the previous point of the merged output, mirroring how the
   * recorder gates live fixes. Defaults to accepting everything.
   */
  accept?: AcceptFix;
}

/**
 * Merge `incoming` (background-journaled) points into `base` (the recorded
 * track), deduplicating by timestamp and keeping the result time-ordered.
 *
 * - `base` is assumed time-ordered (the recorder enforces monotonic fixes).
 * - `incoming` may be unsorted and may contain duplicates — of itself or of
 *   `base`. First occurrence wins within `incoming`; `base` wins ties.
 * - `opts.accept` vets each surviving incoming point against its would-be
 *   predecessor in the merged track (accuracy/teleport/near-duplicate gating).
 * - Returns `base` (same reference) when nothing new was merged, so callers
 *   can cheaply detect a no-op.
 */
export function mergeTrackPoints(
  base: TrackPoint[],
  incoming: TrackPoint[],
  opts?: MergeTrackPointsOptions,
): TrackPoint[] {
  if (incoming.length === 0) return base;
  const accept = opts?.accept ?? (() => true);

  // Novel incoming points: timestamps not already recorded, first-seen wins.
  const seen = new Set<number>(base.map((p) => p.time));
  const novel: TrackPoint[] = [];
  for (const p of incoming) {
    if (seen.has(p.time)) continue;
    seen.add(p.time);
    novel.push(p);
  }
  if (novel.length === 0) return base;
  novel.sort((a, b) => a.time - b.time);

  // Two-pointer merge; the accept gate sees the actual predecessor in the
  // merged output (which may itself be a just-merged incoming point).
  const merged: TrackPoint[] = [];
  let i = 0;
  let j = 0;
  while (i < base.length || j < novel.length) {
    const b = base[i];
    const n = novel[j];
    if (b !== undefined && (n === undefined || b.time <= n.time)) {
      merged.push(b);
      i += 1;
    } else if (n !== undefined) {
      j += 1;
      if (accept(merged[merged.length - 1], n)) merged.push(n);
    }
  }

  // Every novel point was rejected by the gate — the track is unchanged.
  return merged.length === base.length ? base : merged;
}
