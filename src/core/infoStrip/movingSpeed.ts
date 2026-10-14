/**
 * Moving speed over the last 10 minutes, for ETE and ETA (owner Q2): the
 * distance covered while moving divided by the time spent moving, over a
 * sliding window. Stops (a break, a photo) do not drag it down, and a fresh
 * pace after a climb shows within minutes.
 *
 * Incremental: each fix adds one segment and evicts the ones that left the
 * window, keeping running sums — O(1) amortised per fix, one haversine.
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
  /** Add a fix (epoch ms). Out-of-order or duplicate times are ignored. */
  push(p: LatLng, atMs: number): void;
  /** Moving speed, m/s, or null while warming up or when nothing moved in the window. */
  speedMps(nowMs: number): number | null;
  reset(): void;
}

export function createMovingSpeedWindow(): MovingSpeedWindow {
  let segments: Segment[] = [];
  let head = 0;
  let sumM = 0;
  let sumS = 0;
  let last: { p: LatLng; atMs: number } | null = null;
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
    push(p, atMs) {
      if (last !== null && atMs <= last.atMs) return;
      firstMs ??= atMs;
      if (last !== null && atMs - last.atMs <= MOVING_MAX_GAP_MS) {
        const dtS = (atMs - last.atMs) / 1000;
        const dM = haversineMeters(last.p, p);
        if (dM / dtS >= MOVING_SEGMENT_MIN_MPS) {
          segments.push({ endMs: atMs, dM, dtS });
          sumM += dM;
          sumS += dtS;
        }
      }
      last = { p, atMs };
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
      last = null;
      firstMs = null;
    },
  };
}
