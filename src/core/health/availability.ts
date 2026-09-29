/**
 * Whether the platform's health store can be used at all.
 *
 * - `available`: ask for permissions and import.
 * - `needs-install`: Health Connect is missing or too old (Android 9–13,
 *   where it is a Play Store app) — offer the install link.
 * - `unavailable`: no health store on this device (iPad without Health,
 *   Android 8 or older, web).
 */
export type HealthAvailability = 'available' | 'needs-install' | 'unavailable';

/** First Android API level Health Connect runs on (Android 9). */
export const HEALTH_CONNECT_MIN_API = 28;

/** Health Connect's `getSdkStatus` values (`HealthConnectClient.SDK_*`). */
export const HC_SDK_UNAVAILABLE = 1;
export const HC_SDK_PROVIDER_UPDATE_REQUIRED = 2;
export const HC_SDK_AVAILABLE = 3;

/**
 * Map `getSdkStatus()`. The client reports "provider update required" both
 * when the Health Connect app is outdated and when it isn't installed.
 */
export function healthConnectAvailability(sdkStatus: number): HealthAvailability {
  switch (sdkStatus) {
    case HC_SDK_AVAILABLE:
      return 'available';
    case HC_SDK_PROVIDER_UPDATE_REQUIRED:
      return 'needs-install';
    default:
      return 'unavailable';
  }
}

/** Play Store deep link that installs Health Connect and lands on its onboarding. */
export const HEALTH_CONNECT_INSTALL_URL =
  'market://details?id=com.google.android.apps.healthdata&url=healthconnect%3A%2F%2Fonboarding';
