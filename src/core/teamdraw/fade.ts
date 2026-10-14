/**
 * The fade of a drawing over its life (#683).
 *
 * Full opacity, then a smoothstep from 100 % down to 30 % over the last 25 %
 * of the life (the window clamped to [5 s, 15 min]), then gone. It never
 * reaches 0 % while it can still be tapped. "Never" does not fade.
 *
 * Opacity is quantised to 0.05 and the time left (shown in the badge only
 * inside the window) to 1 s under 10 s, 5 s under a minute and whole minutes
 * above, so the map source is rebuilt only when the quantised frame changes:
 * {@link nextChangeAt} says when that next happens (no timer at all while
 * every shape is long or Never and outside its window).
 */

export const FADE_SHARE = 0.25;
export const FADE_MIN_MS = 5_000;
export const FADE_MAX_MS = 15 * 60_000;
export const FADE_FLOOR = 0.3;
export const OPACITY_STEP = 0.05;
/** The fade timer never wakes more often than this. */
export const MIN_TICK_MS = 1_000;

/** What the fade needs of a shape: its creation and expiry (null = never), epoch ms. */
export interface Life {
  created: number;
  expires: number | null;
}

/** The fade window of a life of `lifeMs`. */
export function fadeWindowMs(lifeMs: number): number {
  return Math.min(FADE_MAX_MS, Math.max(FADE_MIN_MS, lifeMs * FADE_SHARE));
}

const smoothstep = (p: number) => p * p * (3 - 2 * p);
/** Inverse of smoothstep on [0, 1]. */
const unsmooth = (s: number) => 0.5 - Math.sin(Math.asin(1 - 2 * s) / 3);

/** When the window starts, or null for Never. */
export function fadeStart(l: Life): number | null {
  if (l.expires === null) return null;
  return l.expires - fadeWindowMs(l.expires - l.created);
}

/** Exact opacity at `now`: 1 before the window, ≥ 0.3 inside it, 0 once expired. */
export function opacityAt(l: Life, now: number): number {
  if (l.expires === null) return 1;
  if (now >= l.expires) return 0;
  const start = fadeStart(l)!;
  if (now <= start) return 1;
  const p = (now - start) / (l.expires - start);
  return 1 - (1 - FADE_FLOOR) * smoothstep(p);
}

/** Opacity in steps of 0.05 (never below the floor while visible). */
export function quantOpacity(o: number): number {
  if (o <= 0) return 0;
  const steps = Math.round(1 / OPACITY_STEP);
  return Math.max(FADE_FLOOR, Math.round(o * steps) / steps);
}

/** Time left in seconds, quantised: 1 s under 10 s, 5 s under a minute, whole minutes above. */
export function quantLeftS(remainingMs: number): number {
  const s = Math.ceil(remainingMs / 1000);
  if (s < 10) return s;
  if (s <= 60) return Math.ceil(s / 5) * 5;
  return Math.ceil(s / 60) * 60;
}

/** The remaining time (ms) below which {@link quantLeftS} changes from `q`. */
function leftBandFloorMs(q: number): number {
  if (q < 10) return (q - 1) * 1000;
  if (q === 10) return 9_000;
  if (q <= 60) return (q - 5) * 1000;
  return (q - 60) * 1000;
}

/** "15 s", "2 min". */
export function formatLeft(s: number): string {
  return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`;
}

export interface FadeState {
  visible: boolean;
  /** Quantised opacity. */
  opacity: number;
  /** Quantised seconds left, only inside the fade window (null outside it, and for Never). */
  left: number | null;
}

export function fadeState(l: Life, now: number): FadeState {
  if (l.expires === null) return { visible: true, opacity: 1, left: null };
  if (now >= l.expires) return { visible: false, opacity: 0, left: null };
  const inWindow = now > fadeStart(l)!;
  return {
    visible: true,
    opacity: quantOpacity(opacityAt(l, now)),
    left: inWindow ? quantLeftS(l.expires - now) : null,
  };
}

/** The first instant after `now` at which this shape's quantised state changes, or null. */
function nextChangeOf(l: Life, now: number): number | null {
  if (l.expires === null || now >= l.expires) return null;
  const start = fadeStart(l)!;
  if (now <= start) return Math.floor(start) + 1; // the badge clock appears (opacity still 1)
  let next = l.expires;
  // The badge's clock.
  const floor = leftBandFloorMs(quantLeftS(l.expires - now));
  next = Math.min(next, l.expires - floor);
  // The next opacity step (monotone: solve the smoothstep for the step's lower edge).
  const q = Math.round(opacityAt(l, now) / OPACITY_STEP);
  const edge = (q - 0.5) * OPACITY_STEP;
  if (edge > FADE_FLOOR) {
    const p = unsmooth((1 - edge) / (1 - FADE_FLOOR));
    next = Math.min(next, Math.floor(start + p * (l.expires - start)) + 1);
  }
  return Math.max(next, now + 1);
}

/** The earliest instant after `now` when any shape's quantised frame changes, or null (no timer). */
export function nextChangeAt(shapes: readonly Life[], now: number): number | null {
  let best: number | null = null;
  for (const s of shapes) {
    const t = nextChangeOf(s, now);
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best;
}

/** How long the fade timer sleeps until `next` (at least {@link MIN_TICK_MS}), or null. */
export function tickDelayMs(next: number | null, now: number): number | null {
  return next === null ? null : Math.max(MIN_TICK_MS, next - now);
}

/**
 * How many shapes are on the map at `now` (an expired one is not, though the
 * snapshot it came in may still hold it), and when that number next drops
 * (the first expiry still ahead; null when none will). Manage team ›
 * Drawings said "5 on the map" over an empty map (2.5.2 QA).
 */
export function onMapCount(
  shapes: readonly { expires: number | null }[],
  now: number,
): { count: number; changesAt: number | null } {
  let count = 0;
  let changesAt: number | null = null;
  for (const s of shapes) {
    if (s.expires !== null && s.expires <= now) continue;
    count++;
    if (s.expires !== null && (changesAt === null || s.expires < changesAt)) changesAt = s.expires;
  }
  return { count, changesAt };
}
