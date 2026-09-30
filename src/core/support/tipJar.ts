/**
 * The floating tip-jar button on the main tabs (#476, round 2): when it shows
 * and when it moves. The component (`features/support/TipJarButton`) only
 * applies these rules.
 *
 * Guard rails (owner may change them):
 * - hidden by the "Show the tip jar button" setting (on by default), and
 *   while a recording runs or a destination is being followed (the map is a
 *   tool then, not a place to ask for money), and whenever the host screen
 *   says something else owns the bottom edge (a sheet, the region selector);
 * - a small wobble every {@link TIP_JAR_WOBBLE_INTERVAL_MS}, lasting well
 *   under a second, and never when the OS asks for reduced motion or once
 *   the person has tipped: thanked people are not nudged.
 *
 * Pure: no React Native / Expo imports.
 */

export const TIP_JAR_WOBBLE_INTERVAL_MS = 15_000;

/** One wobble: rotation targets (degrees) and the time to reach each (ms). */
export const TIP_JAR_WOBBLE: readonly { deg: number; ms: number }[] = [
  { deg: 3, ms: 90 },
  { deg: -3, ms: 140 },
  { deg: 2, ms: 120 },
  { deg: -1.5, ms: 110 },
  { deg: 0, ms: 100 },
];

export function wobbleDurationMs(steps = TIP_JAR_WOBBLE): number {
  return steps.reduce((sum, step) => sum + step.ms, 0);
}

export interface TipJarContext {
  /** The "Show the tip jar button" setting. */
  enabled: boolean;
  recording: boolean;
  /** A destination is being followed on the map. */
  navigating: boolean;
  /** The host screen has something in the bottom-right corner right now. */
  blocked: boolean;
}

export function tipJarVisible(ctx: TipJarContext): boolean {
  return ctx.enabled && !ctx.recording && !ctx.navigating && !ctx.blocked;
}

export function tipJarAnimates(opts: { reduceMotion: boolean; hasTipped: boolean }): boolean {
  return !opts.reduceMotion && !opts.hasTipped;
}
