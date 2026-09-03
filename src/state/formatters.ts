/**
 * The app's formatters, bound to the user's chosen unit system.
 *
 * `@core/format` is pure: every unit-dependent formatter there takes the unit
 * system as an argument. This module is the one place that knows where units
 * come from — `settingsStore.units` — so the ~50 UI call sites keep their
 * terse `formatDistance(meters)` shape without `@core` reaching into app
 * state.
 *
 * Units are read PER CALL (`getState()`, not a subscription), which is exactly
 * what the previous `setDisplayUnits` global did: a screen picks up a unit
 * change on its next render. Components that must re-render the moment units
 * flip should subscribe (`useSettingsStore((s) => s.units)`) and use
 * `createFormatters` from `@core/format` directly.
 *
 * The unit-independent formatters (`formatDuration`, `formatTimestamp`,
 * `formatBytes`, `headingToCardinal`) are re-exported unchanged so a screen
 * that needs both kinds still has a single import; a screen that needs only
 * those should import them straight from `@core/format`.
 */

import {
  formatDistance as formatDistanceIn,
  formatElevation as formatElevationIn,
  formatPace as formatPaceIn,
  formatSpeed as formatSpeedIn,
  type Units,
} from '@core/format';
import { useSettingsStore } from './settingsStore';

export { formatBytes, formatDuration, formatTimestamp, headingToCardinal } from '@core/format';
export type { Units } from '@core/format';

const currentUnits = (): Units => useSettingsStore.getState().units;

/** Metres -> "1.23 km" / "840 m", or the imperial equivalent. */
export const formatDistance = (meters: number): string => formatDistanceIn(meters, currentUnits());

/** Metres -> "1234 m" / "4049 ft" (elevation, no decimals). */
export const formatElevation = (meters: number): string =>
  formatElevationIn(meters, currentUnits());

/** m/s -> "4.2 km/h" / "2.6 mph". */
export const formatSpeed = (mps: number): string => formatSpeedIn(mps, currentUnits());

/** m/s -> "6:00/km" / "9:39/mi" pace, or "—". */
export const formatPace = (mps: number): string => formatPaceIn(mps, currentUnits());
