/** Human-readable formatting for the live HUD and library. Pure functions. */

/** Display unit system for distance/elevation/speed/pace formatting. */
export type Units = 'metric' | 'imperial';

const M_PER_FT = 0.3048;
const M_PER_MI = 1609.344;
const MPH_PER_MPS = 3600 / M_PER_MI;

let displayUnits: Units = 'metric';

/**
 * Select the unit system used by formatDistance/formatElevation/formatSpeed/
 * formatPace. Module-level so the many existing call sites keep their
 * `(value) => string` signatures — the settings store calls this on hydrate,
 * on change, and on reset.
 */
export function setDisplayUnits(units: Units): void {
  displayUnits = units;
}

/** Metres -> "1.23 km" / "840 m" (metric) or "1.23 mi" / "840 ft" (imperial). */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) {
    return displayUnits === 'imperial' ? '0 ft' : '0 m';
  }
  if (displayUnits === 'imperial') {
    const feet = meters / M_PER_FT;
    // Switch to miles at the same threshold the rounding uses, so a value that
    // would round to 1000 ft renders as miles instead of "1000 ft".
    if (Math.round(feet) < 1000) return `${Math.round(feet)} ft`;
    const miles = meters / M_PER_MI;
    return miles < 10 ? `${miles.toFixed(2)} mi` : `${miles.toFixed(1)} mi`;
  }
  // Same boundary rule: [999.5, 1000) must render as km, never "1000 m".
  if (Math.round(meters) < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

/** Metres -> "1 234 m" or "4 049 ft" (elevation, no decimals). */
export function formatElevation(meters: number): string {
  if (!Number.isFinite(meters)) return displayUnits === 'imperial' ? '0 ft' : '0 m';
  if (displayUnits === 'imperial') return `${Math.round(meters / M_PER_FT)} ft`;
  return `${Math.round(meters)} m`;
}

/** Seconds -> "H:MM:SS" or "M:SS". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** m/s -> "4.2 km/h" or "2.6 mph". */
export function formatSpeed(mps: number): string {
  if (!Number.isFinite(mps) || mps < 0) {
    return displayUnits === 'imperial' ? '0.0 mph' : '0.0 km/h';
  }
  if (displayUnits === 'imperial') return `${(mps * MPH_PER_MPS).toFixed(1)} mph`;
  return `${(mps * 3.6).toFixed(1)} km/h`;
}

/** m/s -> "6:00/km" or "9:39/mi" pace. Returns "—" for non-positive/implausible speeds. */
export function formatPace(mps: number): string {
  if (!Number.isFinite(mps) || mps <= 0.1) return '—';
  const secPerUnit = (displayUnits === 'imperial' ? M_PER_MI : 1000) / mps;
  if (secPerUnit > 99 * 60) return '—';
  const m = Math.floor(secPerUnit / 60);
  const s = Math.round(secPerUnit % 60);
  const mm = s === 60 ? m + 1 : m;
  const ss = s === 60 ? 0 : s;
  return `${mm}:${ss.toString().padStart(2, '0')}/${displayUnits === 'imperial' ? 'mi' : 'km'}`;
}

/** Heading degrees -> cardinal abbreviation (N, NE, …). */
export function headingToCardinal(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const idx = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return dirs[idx] ?? 'N';
}

/** Epoch ms -> short local date+time, e.g. "Jun 15, 14:32". */
export function formatTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Bytes -> human-readable size, e.g. "840 KB", "12 MB" or "1.2 GB". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 KB';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${(n / 1e3).toFixed(0)} KB`;
}
