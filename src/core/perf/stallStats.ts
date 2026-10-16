/**
 * JS-thread stall statistics from a heartbeat (#722): a timer asks to fire
 * every `intervalMs`; whenever the thread is blocked, the next beat arrives
 * late. The lateness of each beat is time the thread could not run anything
 * else — touches, gesture callbacks, renders.
 */

export interface StallStats {
  beats: number;
  /** Sum of lateness over beats later than `longTaskMs` (ms). */
  blockedMs: number;
  /** Longest single gap between beats (ms). */
  maxGapMs: number;
  /** Beats arriving more than `longTaskMs` late (≈ long tasks). */
  longTasks: number;
}

/** Stats from ascending beat timestamps (ms). */
export function stallStats(
  beatsMs: readonly number[],
  intervalMs: number,
  longTaskMs = 50,
): StallStats {
  let blockedMs = 0;
  let maxGapMs = 0;
  let longTasks = 0;
  for (let i = 1; i < beatsMs.length; i++) {
    const gap = beatsMs[i]! - beatsMs[i - 1]!;
    if (gap > maxGapMs) maxGapMs = gap;
    const late = gap - intervalMs;
    if (late > longTaskMs) {
      blockedMs += late;
      longTasks++;
    }
  }
  return { beats: beatsMs.length, blockedMs, maxGapMs, longTasks };
}

/** Nearest-rank percentile (p in 0–100) of unsorted values; NaN when empty. */
export function percentileOf(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[rank]!;
}
