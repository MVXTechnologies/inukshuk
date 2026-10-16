import { createFormatters, type Units } from '@core/format';
import type { TrailTiming } from '@core/geo/track';
import type { TrackStats } from '@core/models';

import { compactDuration } from './libraryRows';

/**
 * The trail view's pull-down sheet (#740, owner pick "Option 1"): the tabs
 * fold into a peek — the trail's stats and a scrubbable profile — so the
 * map grows to fill the screen; the action bar stays. Drag the grabber down
 * to fold, up (or the chevron) to unfold.
 *
 * PURE: no React Native / Expo imports.
 */

export type TrailSheet = 'full' | 'peek';

/** A drag farther than this (dp) folds or unfolds the sheet. */
export const SHEET_SWIPE_DP = 40;
/** A flick faster than this (dp/ms) does too, however short. */
export const SHEET_FLICK_V = 0.5;

/** Where the sheet settles after a drag of `dy` (down positive) at velocity `vy`. */
export function sheetAfterDrag(state: TrailSheet, dy: number, vy = 0): TrailSheet {
  if (state === 'full' && (dy > SHEET_SWIPE_DP || vy > SHEET_FLICK_V)) return 'peek';
  if (state === 'peek' && (dy < -SHEET_SWIPE_DP || vy < -SHEET_FLICK_V)) return 'full';
  return state;
}

/**
 * How far the sheet follows the finger while dragging (dp): only the way it
 * can go (down when full, up when folded), and damped past the threshold.
 */
export function sheetDragOffset(state: TrailSheet, dy: number): number {
  const d = state === 'full' ? Math.max(0, dy) : Math.min(0, dy);
  const a = Math.abs(d);
  const eased = a <= SHEET_SWIPE_DP ? a : SHEET_SWIPE_DP + (a - SHEET_SWIPE_DP) * 0.35;
  return Math.sign(d) * eased;
}

/** The peek's stats, mockup order: "12.4 km", "+640 m", "3:42" (moving time, when timed). */
export function peekStats(
  stats: Pick<TrackStats, 'distanceM' | 'ascentM'>,
  timing: Pick<TrailTiming, 'movingTimeS'> | null,
  units: Units,
): string[] {
  const fmt = createFormatters(units);
  return [
    fmt.formatDistance(stats.distanceM),
    `+${fmt.formatElevation(stats.ascentM)}`,
    ...(timing && timing.movingTimeS > 0 ? [compactDuration(timing.movingTimeS)] : []),
  ];
}
