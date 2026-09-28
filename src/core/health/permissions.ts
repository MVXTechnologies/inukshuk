/**
 * Health permission outcomes, decided purely from what the platform reports.
 */

export type HealthPermissionOutcome = 'granted' | 'partial' | 'denied';

/** A permission as `react-native-health-connect` requests and reports it. */
export interface HealthConnectPermissionLike {
  accessType: string;
  recordType: string;
}

function key(p: HealthConnectPermissionLike): string {
  return `${p.accessType}:${p.recordType}`;
}

/**
 * Outcome of a Health Connect request: `denied` without the `essential`
 * permission (nothing can be listed), `granted` with everything asked for,
 * `partial` otherwise (e.g. no history beyond 30 days, or no distance).
 */
export function healthConnectOutcome(
  requested: readonly HealthConnectPermissionLike[],
  granted: readonly HealthConnectPermissionLike[],
  essential: HealthConnectPermissionLike,
): HealthPermissionOutcome {
  const have = new Set(granted.map(key));
  if (!have.has(key(essential))) return 'denied';
  return requested.every((p) => have.has(key(p))) ? 'granted' : 'partial';
}

/** True when `granted` includes the permission. */
export function hasHealthConnectPermission(
  granted: readonly HealthConnectPermissionLike[],
  wanted: HealthConnectPermissionLike,
): boolean {
  return granted.some((p) => key(p) === key(wanted));
}
