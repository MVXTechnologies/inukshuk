/**
 * Human-readable formatting for the live HUD, the Library and the exports.
 *
 * Every function here is REFERENTIALLY TRANSPARENT: the unit system is an
 * argument, never hidden module state. It used to be a `let displayUnits`
 * that the settings store poked through `setDisplayUnits()`, which meant
 * `formatDistance(1609)` returned "1.61 km" or "1.00 mi" depending on state
 * this module could not see — the one thing `src/core` must not do.
 *
 * The `(value) => string` call shape the ~50 UI call sites want is now built
 * by {@link createFormatters}; `src/state/formatters.ts` holds the instance
 * bound to the settings store, which is the single source of truth for units.
 *
 * The unit-dependent formatters (distance, elevation, speed, pace, accuracy)
 * and the unit model itself live in `./units` (#702), re-exported here.
 */

import { formatDistance, formatElevation, formatPace, formatSpeed, type Units } from './units';

export * from './units';

/** Seconds -> "H:MM:SS" or "M:SS". Unit-system independent. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Heading degrees -> cardinal abbreviation (N, NE, …). Unit-system independent. */
export function headingToCardinal(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const idx = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return dirs[idx] ?? 'N';
}

/** Epoch ms -> short local date+time, e.g. "Jun 15, 14:32". Unit-system independent. */
export function formatTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Epoch ms -> local clock time, e.g. "9:12" / "09:12" / "9:12 AM" per the device locale. */
export function formatClockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * Seconds -> a spoken-style span for stops: "45 s", "18 min", "1 h 05 min".
 * Rounded to the minute from one minute up.
 */
export function formatSpan(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const totalMin = Math.round(seconds / 60);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h} h ${m.toString().padStart(2, '0')} min`;
}

/** Bytes -> human-readable size, e.g. "840 KB", "12 MB" or "1.2 GB". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 KB';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${(n / 1e3).toFixed(0)} KB`;
}

/** The unit-dependent formatters, pre-bound to one unit system. */
export interface Formatters {
  formatDistance: (meters: number) => string;
  formatElevation: (meters: number) => string;
  formatSpeed: (mps: number) => string;
  formatPace: (mps: number) => string;
}

/**
 * Bind the unit-dependent formatters to a unit system.
 *
 * This is what keeps the call sites terse without a hidden global: the units
 * are captured here, once, by whoever knows them (the settings store).
 */
export function createFormatters(units: Units): Formatters {
  return {
    formatDistance: (meters) => formatDistance(meters, units),
    formatElevation: (meters) => formatElevation(meters, units),
    formatSpeed: (mps) => formatSpeed(mps, units),
    formatPace: (mps) => formatPace(mps, units),
  };
}
