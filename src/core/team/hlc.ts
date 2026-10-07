import { MAX_FUTURE_SKEW_MS } from '@core/sync/clock';

/**
 * Hybrid logical clock (Kulkarni et al., 2014) for team ops (#589).
 *
 * Sync M0 (`@core/sync/clock`) stamps with wall-clock ms, which is enough for
 * one user with a few devices. A team breaks that: many devices write the same
 * records, so equal stamps are common and ties must break the same way on
 * every phone. An HLC keeps the wall-clock feel (`wall` ≈ real time, so "last
 * writer wins" still means what users expect) while staying monotonic per
 * device and ≥ every stamp the device has seen (causality). The total order is
 * `(wall, counter, author)` — see {@link compareStamp}.
 *
 * The future-skew bound is shared with M0 ({@link MAX_FUTURE_SKEW_MS}): a stamp
 * more than that ahead of the receiver's clock is refused (signed ops cannot
 * be clamped like M0's unsigned stamps), so a phone with a wrong clock cannot
 * win every LWW comparison for months, and cannot drag everyone's clock far
 * forward.
 */
export interface Hlc {
  /** Epoch ms. */
  wall: number;
  /** Logical counter for events within the same `wall` ms. */
  counter: number;
}

/** An HLC plus its author: the LWW stamp of one write. Totally ordered. */
export interface Stamp extends Hlc {
  author: string;
}

export const MAX_COUNTER = 0xffff;
/** Stamps before 2020-01-01 are junk (a phone with a reset RTC). */
export const MIN_WALL = Date.UTC(2020, 0, 1);
export { MAX_FUTURE_SKEW_MS };

export const ZERO_HLC: Hlc = { wall: 0, counter: 0 };

/** Structural check of a wire `[wall, counter]` pair. */
export function parseHlc(value: unknown): Hlc | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [wall, counter] = value as unknown[];
  if (!Number.isSafeInteger(wall) || !Number.isSafeInteger(counter)) return undefined;
  if ((wall as number) < MIN_WALL || (counter as number) < 0 || (counter as number) > MAX_COUNTER) {
    return undefined;
  }
  return { wall: wall as number, counter: counter as number };
}

export function hlcToWire(h: Hlc): [number, number] {
  return [h.wall, h.counter];
}

function sanitizeNow(now: number): number {
  return Number.isFinite(now) && now > 0 ? Math.floor(now) : 0;
}

function bump(wall: number, counter: number): Hlc {
  return counter > MAX_COUNTER ? { wall: wall + 1, counter: 0 } : { wall, counter };
}

/** Stamp for a local event (sending an op). Monotonic even if `now` goes backwards. */
export function hlcTick(last: Hlc, now: number): Hlc {
  const wall = Math.max(last.wall, sanitizeNow(now));
  return bump(wall, wall === last.wall ? last.counter + 1 : 0);
}

/**
 * Advance the local clock past a remote stamp we accepted. Callers must have
 * refused remote stamps beyond the skew bound first ({@link isTooFarAhead}).
 */
/**
 * How far past its own wall clock a device lets a peer's stamp push its HLC
 * (review M1). Acceptance still allows {@link MAX_FUTURE_SKEW_MS}; only the
 * local clock's lead is bounded.
 */
export const MAX_CLOCK_LEAD_MS = 5 * 60 * 1000;

export function hlcObserve(last: Hlc, remote: Hlc, now: number, maxLeadMs = Infinity): Hlc {
  const n = sanitizeNow(now);
  if (remote.wall > n + maxLeadMs) remote = { wall: n + maxLeadMs, counter: 0 };
  const wall = Math.max(last.wall, remote.wall, n);
  let counter: number;
  if (wall === last.wall && wall === remote.wall)
    counter = Math.max(last.counter, remote.counter) + 1;
  else if (wall === last.wall) counter = last.counter + 1;
  else if (wall === remote.wall) counter = remote.counter + 1;
  else counter = 0;
  return bump(wall, counter);
}

export function isTooFarAhead(h: Hlc, now: number, maxFutureMs = MAX_FUTURE_SKEW_MS): boolean {
  return h.wall > sanitizeNow(now) + maxFutureMs;
}

export function compareHlc(a: Hlc, b: Hlc): number {
  return a.wall - b.wall || a.counter - b.counter;
}

/** Total order: HLC, then author id (plain code-unit order, identical on every device). */
export function compareStamp(a: Stamp, b: Stamp): number {
  const c = compareHlc(a, b);
  if (c !== 0) return c;
  return a.author < b.author ? -1 : a.author > b.author ? 1 : 0;
}

export function maxStamp<T extends Stamp>(a: T | undefined, b: T | undefined): T | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return compareStamp(a, b) >= 0 ? a : b;
}
