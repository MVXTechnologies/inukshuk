/**
 * Moving speed over the last 10 minutes, for ETE and ETA (owner Q2): the
 * distance covered while moving divided by the time spent moving, over a
 * sliding window. Stops (a break, a photo) do not drag it down, and a fresh
 * pace after a climb shows within minutes.
 *
 * Incremental: each fix adds at most one segment and evicts the ones that
 * left the window, keeping running sums — O(1) amortised per fix, one
 * haversine.
 *
 * Fixes are timed by their own timestamps (the fix's `time`), never by when
 * the UI got round to them. GPS jitter is rejected by the fixes' accuracy: a
 * move shorter than the two fixes' accuracy radii together is no move — the
 * window keeps measuring from the earlier fix (its anchor) until you have
 * really left it, so a slow walk still counts and a 15 m jump while standing
 * with ±8 m fixes does not.
 */
import { haversineMeters } from '@core/geo/geomath';
import type { LatLng } from '@core/models';

/** The window, ms (Q2: "moving speed over 10 min"). */
export const MOVING_WINDOW_MS = 10 * 60_000;
/** No estimate until the fixes span this long, ms (Q2: "— in the first 2 min"). */
export const MOVING_WARMUP_MS = 2 * 60_000;
/** A segment slower than this is a stop (GPS jitter while standing), m/s. */
export const MOVING_SEGMENT_MIN_MPS = 0.3;
/** A gap longer than this between two fixes is not a segment (signal lost), ms. */
export const MOVING_MAX_GAP_MS = 60_000;

interface Segment {
  endMs: number;
  dM: number;
  dtS: number;
}

export interface MovingSpeedWindow {
  /**
   * Add a fix: its own time (epoch ms) and its horizontal accuracy radius
   * (metres; null or absent when unknown, then every move counts).
   * Out-of-order or duplicate times are ignored.
   */
  push(p: LatLng, atMs: number, accuracyM?: number | null): void;
  /** Moving speed, m/s, or null while warming up or when nothing moved in the window. */
  speedMps(nowMs: number): number | null;
  reset(): void;
}

export function createMovingSpeedWindow(): MovingSpeedWindow {
  let segments: Segment[] = [];
  let head = 0;
  let sumM = 0;
  let sumS = 0;
  /** The fix segments are measured from: the last one you really moved away from. */
  let anchor: { p: LatLng; atMs: number; accM: number } | null = null;
  let lastMs: number | null = null;
  let firstMs: number | null = null;

  const evict = (nowMs: number) => {
    while (head < segments.length && segments[head]!.endMs <= nowMs - MOVING_WINDOW_MS) {
      const s = segments[head]!;
      sumM -= s.dM;
      sumS -= s.dtS;
      head++;
    }
    // An empty window is exactly zero, not the running sums' rounding residue.
    if (head === segments.length) {
      sumM = 0;
      sumS = 0;
    }
    // Compact once the dead prefix outgrows the live part.
    if (head > 64 && head * 2 > segments.length) {
      segments = segments.slice(head);
      head = 0;
    }
  };

  return {
    push(p, atMs, accuracyM = null) {
      if (!Number.isFinite(atMs) || (lastMs !== null && atMs <= lastMs)) return;
      lastMs = atMs;
      firstMs ??= atMs;
      const accM =
        accuracyM !== null && Number.isFinite(accuracyM) && accuracyM > 0 ? accuracyM : 0;
      if (anchor === null || atMs - anchor.atMs > MOVING_MAX_GAP_MS) {
        // The first fix, or a stop / lost signal longer than a segment may span.
        anchor = { p, atMs, accM };
      } else {
        const dM = haversineMeters(anchor.p, p);
        // Inside the two fixes' accuracy: jitter, not a move; keep the anchor.
        if (dM >= anchor.accM + accM) {
          const dtS = (atMs - anchor.atMs) / 1000;
          if (dM / dtS >= MOVING_SEGMENT_MIN_MPS) {
            segments.push({ endMs: atMs, dM, dtS });
            sumM += dM;
            sumS += dtS;
          }
          anchor = { p, atMs, accM };
        }
      }
      evict(atMs);
    },
    speedMps(nowMs) {
      evict(nowMs);
      if (firstMs === null || nowMs - firstMs < MOVING_WARMUP_MS) return null;
      return sumS > 0 ? sumM / sumS : null;
    },
    reset() {
      segments = [];
      head = 0;
      sumM = 0;
      sumS = 0;
      anchor = null;
      lastMs = null;
      firstMs = null;
    },
  };
}
