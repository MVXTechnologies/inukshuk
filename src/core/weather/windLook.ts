/**
 * Visual tuning for the wind particle overlay — the LOOK knobs.
 *
 * Deliberately separate from `windPerf.ts`, which holds the PERFORMANCE gate
 * (`TARGET_PARTICLES`: what the Android target must sustain). ecb694a split
 * those two on purpose and they must stay split: a "the overlay is too busy"
 * complaint moves the numbers in THIS file, never the gate.
 *
 * Everything here is pure so the numbers can be reasoned about (and pinned by
 * the co-located test) without a GL context. `windGl.ts` interpolates the
 * constants straight into its GLSL, so the shader and these functions cannot
 * drift apart on the values — only the formulas are written twice, and the
 * test below pins the shape of each one.
 *
 * ## The bug these numbers exist to fix (owner review, 2026-08-13)
 *
 * Streak length and streak brightness BOTH scaled with wind speed, so the two
 * compounded: a fast particle drew a longer trail *and* a brighter one. On
 * device that read as long diagonal smears dragging across the frame at
 * 24 km/h, where the previous (shorter, dimmer) tuning had drawn discrete
 * dashes. Worse, ~20% of particles are "gusty" and advect at up to
 * GUST_RATIO_MAX (×3), so the worst streaks were 3× longer again.
 *
 * The advection is screen-relative — `PX_PER_FRAME_PER_MPS` screen px per
 * frame per m/s — so trail length in pixels is simply
 *
 *     length_px ≈ PX_PER_FRAME_PER_MPS × effective_mps × visible_frames
 *
 * with `visible_frames ≈ 1 / (1 − TRAIL_FADE_OPACITY)`. That makes the length
 * budget something we can state in pixels instead of tuning by feel, which is
 * what `streakLengthPx` below is for.
 */

import { PX_PER_FRAME_PER_MPS } from './windProjection';

/**
 * Trail persistence per frame — how much of the previous frame is kept.
 *
 * A trail is visible for roughly 1/(1 − FADE) frames, so this sets how much
 * of the screen streak ink covers:
 *   0.965 → ~29 frames (originally shipped; "too dense to see the map")
 *   0.95  → ~20 frames (tried: fixed calm air, washed the street grid out)
 *   0.94  → ~17 frames (here)
 *   0.93  → ~14 frames (tried: at 9 km/h the trails degenerated into
 *           scattered specks that no longer read as flow, and light-theme
 *           low wind — the hardest case, white streaks on a pale basemap —
 *           lost the flow entirely)
 *
 * This stays at 0.94 on purpose. It is a FLAT frame budget applied to every
 * particle, so pulling it further to tame fast streaks is what starved calm
 * air last time. The speed-dependent part of the length is now handled by
 * the compression below, which is the lever that can treat the two ends of
 * the wind range differently.
 */
export const TRAIL_FADE_OPACITY = 0.94;

/**
 * Wind speed (m/s) below which advection is completely untouched.
 *
 * 5 m/s is 18 km/h. Everything at or under a light breeze — including the
 * whole of the 9 km/h low-wind case, whose base flow is ~2.5 m/s — advects
 * exactly as before, so the one case the owner signed off on (light theme,
 * low wind) is bit-for-bit unchanged.
 */
export const STREAK_KNEE_MPS = 5;

/**
 * Fraction of each m/s ABOVE the knee that still buys trail length.
 *
 * At 0.25 a particle four times over the knee draws only one extra knee's
 * worth of trail. Speed keeps reading through the colour drape, the streak
 * alpha and the local particle density — it just stops being read through
 * ever-longer smears, which is the thing that buried the basemap.
 */
export const STREAK_EXCESS_GAIN = 0.25;

/**
 * Hard ceiling on effective advection speed (m/s), after the knee AND after
 * the ×3 gust boost.
 *
 * 9 m/s ≈ a 37 px trail at TRAIL_FADE_OPACITY (see `streakLengthPx`), i.e.
 * under a tenth of a phone screen's width — a dash, not a smear. Without a
 * ceiling the knee alone still lets a 60 km/h gust reach ~16 m/s, because a
 * quarter of a large excess is still large.
 */
export const STREAK_MAX_MPS = 9;

/**
 * Effective advection speed for a particle whose true speed (already
 * multiplied by its gust boost) is `mps`.
 *
 * Piecewise-linear with a soft knee, then clamped. Piecewise rather than a
 * smooth curve because it must be exactly the identity below the knee: any
 * smooth compressor that "starts gently" still moves calm air, and calm air
 * is the case with no margin left.
 *
 * The shader applies this as a SCALE on the advection vector, so direction is
 * preserved exactly — only the step magnitude changes.
 */
export function compressedStreakSpeedMps(mps: number): number {
  if (!(mps > 0)) return 0;
  const excess = Math.max(mps - STREAK_KNEE_MPS, 0);
  const kneed = Math.min(mps, STREAK_KNEE_MPS) + excess * STREAK_EXCESS_GAIN;
  return Math.min(kneed, STREAK_MAX_MPS);
}

/**
 * Approximate on-screen trail length, in layout px, for an effective speed.
 *
 * This is the number the length budget is actually stated in. Reference
 * points at the shipped constants (values the co-located test pins):
 *   9 km/h  base  (2.5 m/s)        → ~10 px   (unchanged by the compressor)
 *   9 km/h  gust  (7.5 m/s)        → ~23 px   (was ~31)
 *   24 km/h base  (6.7 m/s)        → ~23 px   (was ~28)
 *   24 km/h gust  (20 m/s)         → ~36 px   (was ~83 — THE smear)
 *   60 km/h gust  (50 m/s)         → ~37 px   (was ~208, half a screen)
 */
export function streakLengthPx(effectiveMps: number, fade = TRAIL_FADE_OPACITY): number {
  const visibleFrames = 1 / Math.max(1 - fade, 1e-6);
  return PX_PER_FRAME_PER_MPS * effectiveMps * visibleFrames;
}

/**
 * Streak alpha at rest — the floor of the brightness ramp.
 *
 * Alpha here is INTENSITY, not coverage: lowering it makes every streak
 * fainter without freeing up any map underneath. 0.28 is set by the worst
 * contrast case (light theme: near-white streaks on a pale cream basemap),
 * where a lower floor simply erased calm-wind areas. Leave it alone unless
 * the light-theme low-wind capture says otherwise.
 */
export const STREAK_ALPHA_FLOOR = 0.28;

/**
 * How much brightness the normalised speed buys, per unit.
 *
 * Cut from 0.38 to 0.18. The floor is untouched, so calm air keeps exactly
 * the visibility the owner approved; what goes away is the compounding at the
 * top end, where a fast particle used to be both longer and much brighter.
 */
export const STREAK_ALPHA_GAIN = 0.18;

/**
 * Ceiling on streak alpha — the flat top of the ramp.
 *
 * Engages at speed_t ≈ 0.67. Past that, extra speed changes the colour under
 * the streak (the drape's job) and the local streak density, but not how hard
 * the streak burns into the basemap. Peak alpha is now 0.40 against the 0.66
 * the rejected captures were rendered at.
 */
export const STREAK_ALPHA_CEIL = 0.4;

/**
 * Streak alpha for a speed normalised against the wind grid's maximum
 * (`speed_t` in the fragment shader), clamped to the flat top.
 */
export function streakAlpha(speedT: number): number {
  const t = Math.min(Math.max(speedT, 0), 1);
  return Math.min(STREAK_ALPHA_FLOOR + STREAK_ALPHA_GAIN * t, STREAK_ALPHA_CEIL);
}

/**
 * `raster-opacity` for the wind SPEED DRAPE (the WMS colour gradient the
 * streaks fly over).
 *
 * 0.30, well below the 0.62 default every other weather layer uses, and the
 * gap is deliberate: wind is the only layer that also draws its own ink on
 * top, so drape + streaks at the normal strength read heavier than any other
 * layer at the normal strength. The ladder this walked down, all measured on
 * device at Québec City in both themes:
 *   0.75 → M3's original; buried the coastlines (owner, 2026-08-10)
 *   0.62 → the shared default; still washed the street grid out at 24 km/h
 *   0.50 → basemap legible in isolation, but across all four capture cases
 *          the owner's verdict was still "the map is always under a wash"
 *   0.30 → here. The gradient still carries the speed reading — it is a
 *          continuous ramp over a desaturated basemap, so it does not need
 *          much opacity to be legible — while the streets, the shoreline and
 *          the Citadelle outline read through it.
 *
 * The counter-argument on record is that a weak drape costs the white streaks
 * their contrast in light theme. It did not show up on device at 0.50, and
 * the streak alpha floor (above) is the knob that answers it if it ever does.
 */
export const WIND_DRAPE_OPACITY = 0.3;
