/**
 * Pure limiter arithmetic for the room and budget objects. State is plain
 * numbers so it fits a WebSocket attachment (which survives hibernation).
 */

/** A token bucket: `tokens` left as of `at` (ms). */
export interface Bucket {
  tokens: number;
  at: number;
}

/**
 * Take `cost` tokens from a bucket refilled at `ratePerS` up to `burst`.
 * Returns the new bucket, or undefined when the cost does not fit (the
 * caller then closes the socket; the bucket is not charged).
 */
export function take(
  b: Bucket,
  now: number,
  cost: number,
  ratePerS: number,
  burst: number,
): Bucket | undefined {
  const elapsed = Math.max(0, now - b.at);
  const tokens = Math.min(burst, b.tokens + (elapsed * ratePerS) / 1000);
  if (tokens < cost) return undefined;
  return { tokens: tokens - cost, at: now };
}

/** Times (ms) inside the last `windowMs`, oldest first. */
export function recent(times: readonly number[], now: number, windowMs: number): number[] {
  return times.filter((t) => now - t < windowMs && t <= now);
}

/** R-RL-2: 20 messages/s, burst 60. */
export const MSG_RATE = 20;
export const MSG_BURST = 60;
/** R-RL-2: 128 KiB/s of frames, burst of the same size. */
export const BYTE_RATE = 128 * 1024;
export const BYTE_BURST = 128 * 1024;
/** R-RL-2: an unauthenticated socket is closed after 10 s… */
export const AUTH_DEADLINE_MS = 10_000;
/** …or after 3 failed attempts. */
export const MAX_AUTH_FAILS = 3;
/** Sockets one room accepts before any of them authenticates (bounds memory). */
export const ROOM_MAX_PENDING = 64;
export const HOUR_MS = 3_600_000;
/** R-TURN-2: the longest credential lifetime, whatever the config says. */
export const TURN_MAX_TTL_S = 900;
