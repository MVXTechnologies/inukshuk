import {
  healthConnectAvailabilityNow,
  healthConnectSource,
  healthConnectSupportedOs,
  openHealthConnectInstall,
  requestHealthConnectPermissions,
} from './healthConnect';
import type { HealthPlatform } from './platform.types';

/** Android: Health Connect. Metro picks this file only for Android bundles. */
export const healthPlatform: HealthPlatform | null = {
  source: healthConnectSource,
  supported: healthConnectSupportedOs,
  availability: healthConnectAvailabilityNow,
  requestPermissions: requestHealthConnectPermissions,
  openInstall: openHealthConnectInstall,
};
