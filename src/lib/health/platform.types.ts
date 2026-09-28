import type { HealthAvailability } from '@core/health/availability';
import type { HealthPermissionOutcome } from '@core/health/permissions';
import type { ActivitySource } from '@core/import/sources';

/** The one health store this platform has, behind a common face. */
export interface HealthPlatform {
  source: ActivitySource;
  /** Synchronous "could this device ever have it" (no native round-trip on Android). */
  supported(): boolean;
  availability(): Promise<HealthAvailability>;
  requestPermissions(): Promise<HealthPermissionOutcome>;
  /** Open the store page that installs the health app, where there is one. */
  openInstall: (() => Promise<void>) | null;
}
