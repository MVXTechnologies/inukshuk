/**
 * The tip button on the Map (#476, rounds 2–3): when it shows, how it looks
 * and when it moves. The component (`features/support/TipButton`) only
 * applies these rules.
 *
 * Guard rails (owner may change them):
 * - Map tab only, in the bottom-right corner;
 * - hidden by the "Show the tip button" setting (on by default), while a
 *   recording runs or a destination is being followed (the map is a tool
 *   then, not a place to ask for money), whenever the map says something
 *   else owns the corner, and for {@link TIP_JAR_REST_MS} (12 months) after a
 *   tip in the app or a verified "I already donated" — then it comes back;
 * - one short animation every {@link TIP_JAR_WOBBLE_INTERVAL_MS} (the chosen
 *   coffee scene lasts ~5 s, the others under a second), never when the OS
 *   asks for reduced motion or once the person has tipped, and paused while
 *   the map is being panned or zoomed and while the app is in the background.
 *
 * Pure: no React Native / Expo imports.
 */

export { TIP_JAR_REST_MS } from './verify';

export const TIP_JAR_WOBBLE_INTERVAL_MS = 15_000;

/**
 * The five icon + animation ideas from the owner's mockup
 * (`TipButton.dc.html`). Switching is a one-line change of
 * {@link DEFAULT_TIP_BUTTON_VARIANT}.
 */
export type TipButtonVariant =
  | 'jarCoin' // 1 · a jar with a coin, wobbles once
  | 'cairnCoin' // 2 · a gold coin drops onto three stones
  | 'stoneHeart' // 3 · a granite heart beats twice
  | 'coffeeSteam' // 4 · a mug, steam rises
  | 'inukshukHeart'; // 5 · the figure with a heart, a soft ring pulses out

export const TIP_BUTTON_VARIANTS: readonly TipButtonVariant[] = [
  'jarCoin',
  'cairnCoin',
  'stoneHeart',
  'coffeeSteam',
  'inukshukHeart',
];

/**
 * Owner pick (2026-09-30): 4 · the coffee mug. The other four stay in the
 * map, unused, so the choice stays a one-line change.
 */
export const DEFAULT_TIP_BUTTON_VARIANT: TipButtonVariant = 'coffeeSteam';

/**
 * The coffee cycle (owner spec): ~4 s of steam wisps rising and dissolving,
 * then a small heart forms from the last wisp above the mug, holds ~0.5 s and
 * fades. One linear 0→1 progress drives it all on the UI thread; the phase
 * boundaries below are fractions of it.
 */
export const COFFEE_CYCLE_MS = 5000;
export const COFFEE_PHASES = {
  /** Steam runs from 0 until here (4 s). */
  steamEnd: 0.8,
  /** The heart has formed (0.3 s later). */
  heartFormed: 0.86,
  /** …holds until here (0.5 s), then fades out by 1. */
  heartHoldEnd: 0.96,
  /** How many times each wisp rises during the steam phase. */
  wispLoops: 3,
  /** Wisps in flight at once, evenly staggered. */
  wisps: 3,
} as const;

/** One step of an animation: the target value and the time to reach it (ms). */
export interface AnimStep {
  to: number;
  ms: number;
  /** Default ease-in-out; `linear` for a progress that drives a longer scene. */
  easing?: 'linear';
}

/**
 * Each variant's one animation, as keyframes on a single value (degrees for
 * rotations, a scale factor, or a 0→1 progress the component maps to a
 * position/opacity). All return to rest.
 */
export const TIP_BUTTON_MOTION: Readonly<Record<TipButtonVariant, readonly AnimStep[]>> = {
  // Rotation (°): a gentle wobble.
  jarCoin: [
    { to: 3, ms: 90 },
    { to: -3, ms: 140 },
    { to: 2, ms: 120 },
    { to: -1.5, ms: 110 },
    { to: 0, ms: 100 },
  ],
  // Progress 0→1: the coin falls in, lands, fades.
  cairnCoin: [
    { to: 0.7, ms: 260 },
    { to: 1, ms: 180 },
    { to: 1, ms: 200 },
    { to: 0, ms: 0 },
  ],
  // Scale: two beats.
  stoneHeart: [
    { to: 1.16, ms: 110 },
    { to: 0.98, ms: 110 },
    { to: 1.1, ms: 110 },
    { to: 1, ms: 150 },
  ],
  // Progress 0→1 (linear): the steam-then-heart scene of COFFEE_PHASES.
  coffeeSteam: [
    { to: 1, ms: COFFEE_CYCLE_MS, easing: 'linear' },
    { to: 0, ms: 0 },
  ],
  // Progress 0→1: a ring pulses out and fades.
  inukshukHeart: [
    { to: 1, ms: 750 },
    { to: 0, ms: 0 },
  ],
};

export function motionDurationMs(steps: readonly AnimStep[]): number {
  return steps.reduce((sum, step) => sum + step.ms, 0);
}

export interface TipJarContext {
  /** The "Show the tip button" setting. */
  enabled: boolean;
  recording: boolean;
  /** A destination is being followed on the map. */
  navigating: boolean;
  /** The map has something in the bottom-right corner right now. */
  blocked: boolean;
  /** Epoch ms until which the button rests after a tip / verified donation (0 = never). */
  restingUntil: number;
  now: number;
}

export function tipJarVisible(ctx: TipJarContext): boolean {
  return (
    ctx.enabled && !ctx.recording && !ctx.navigating && !ctx.blocked && ctx.now >= ctx.restingUntil
  );
}

export function tipJarAnimates(opts: { reduceMotion: boolean; hasTipped: boolean }): boolean {
  return !opts.reduceMotion && !opts.hasTipped;
}
