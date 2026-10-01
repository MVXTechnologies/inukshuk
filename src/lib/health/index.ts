import type { HealthAvailability } from '@core/health/availability';
import type { HealthPermissionOutcome } from '@core/health/permissions';
import type { ActivitySource } from '@core/import/sources';

import { healthPlatform } from './platform';

/**
 * The platform's health store as an import source: Apple Health on iOS,
 * Health Connect on Android (#435). Read-only, on-device.
 *
 * Call order for an import sheet: `healthAvailability()` → (on
 * `needs-install`, `openHealthInstall()`) → `requestHealthPermissions()` →
 * `healthSource().list(...)` / `.fetchRoute(...)`.
 */

export type { HealthAvailability } from '@core/health/availability';
export type { HealthPermissionOutcome } from '@core/health/permissions';

/**
 * The platform's source, or null when this device can never have one (iPad
 * without Health, Android 8 or older, web). On Android a non-null source
 * still needs `healthAvailability()` === 'available' (Health Connect may be
 * missing or outdated).
 */
export function healthSource(): ActivitySource | null {
  return healthPlatform?.supported() ? healthPlatform.source : null;
}

export async function healthAvailability(): Promise<HealthAvailability> {
  return healthPlatform ? healthPlatform.availability() : 'unavailable';
}

/**
 * Ask for read access to workouts + routes (+ distance and full history on
 * Health Connect). On iOS `granted` means the Health sheet was answered —
 * HealthKit never reveals a read denial; it just returns no workouts.
 */
export async function requestHealthPermissions(): Promise<HealthPermissionOutcome> {
  return healthPlatform ? healthPlatform.requestPermissions() : 'denied';
}

/** Open the store page that installs Health Connect; no-op elsewhere. */
export async function openHealthInstall(): Promise<void> {
  await healthPlatform?.openInstall?.();
}
