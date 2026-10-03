/**
 * Fluidity numbers from the gesture harness: the native layer records a
 * timestamp for every frame MapLibre renders; these turn them into the
 * figures the owner asked for (median / p95 / worst frame, % over one and
 * two vsyncs at 60 Hz). Intervals longer than `idleGapMs` are the map
 * resting between script steps (MapLibre renders on demand), not hitches,
 * and are left out.
 */

export const VSYNC_60_MS = 1000 / 60;
export const DEFAULT_IDLE_GAP_MS = 250;

export interface FrameStats {
  frames: number;
  medianMs: number;
  p95Ms: number;
  p99Ms: number;
  worstMs: number;
  /** % of intervals over 16.7 ms (a missed 60 Hz vsync). */
  over16Pct: number;
  /** % of intervals over 33.3 ms (two missed vsyncs). */
  over33Pct: number;
  /** Mean frames per second over the measured intervals. */
  fps: number;
  /** Intervals dropped as idle gaps. */
  idleGaps: number;
}

/** Nearest-rank percentile of an ascending array (p in 0–100). */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((Math.min(Math.max(p, 0), 100) / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

/** Frame intervals (ms) from timestamps (ns), dropping idle gaps. */
export function frameIntervals(
  timesNs: readonly number[],
  idleGapMs = DEFAULT_IDLE_GAP_MS,
): { intervals: number[]; idleGaps: number } {
  const intervals: number[] = [];
  let idleGaps = 0;
  for (let i = 1; i < timesNs.length; i++) {
    const ms = (timesNs[i]! - timesNs[i - 1]!) / 1e6;
    if (!Number.isFinite(ms) || ms <= 0) continue;
    if (ms > idleGapMs) idleGaps++;
    else intervals.push(ms);
  }
  return { intervals, idleGaps };
}

export function frameStats(
  timesNs: readonly number[],
  idleGapMs = DEFAULT_IDLE_GAP_MS,
): FrameStats {
  const { intervals, idleGaps } = frameIntervals(timesNs, idleGapMs);
  const sorted = [...intervals].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((s, x) => s + x, 0);
  const over = (limit: number) =>
    n === 0 ? 0 : (100 * sorted.filter((x) => x > limit).length) / n;
  return {
    frames: n,
    medianMs: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    worstMs: n === 0 ? 0 : sorted[n - 1]!,
    over16Pct: over(VSYNC_60_MS + 0.5),
    over33Pct: over(2 * VSYNC_60_MS + 0.5),
    fps: sum > 0 ? (1000 * n) / sum : 0,
    idleGaps,
  };
}

/** Per-frame cost (ns → ms) summary for the layer's own work. */
export function costStats(costNs: readonly number[]): {
  medianMs: number;
  p95Ms: number;
  worstMs: number;
} {
  const ms = costNs.map((c) => c / 1e6).sort((a, b) => a - b);
  return {
    medianMs: percentile(ms, 50),
    p95Ms: percentile(ms, 95),
    worstMs: ms.length ? ms[ms.length - 1]! : 0,
  };
}
