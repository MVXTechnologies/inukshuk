import {
  appleHealthAvailable,
  appleHealthSource,
  requestAppleHealthPermissions,
} from './appleHealth';
import type { HealthPlatform } from './platform.types';

/** iOS: Apple Health. Metro picks this file only for iOS bundles. */
export const healthPlatform: HealthPlatform | null = {
  source: appleHealthSource,
  supported: appleHealthAvailable,
  availability: async () => (appleHealthAvailable() ? 'available' : 'unavailable'),
  requestPermissions: requestAppleHealthPermissions,
  openInstall: null,
};
