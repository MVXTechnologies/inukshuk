/**
 * The "Recording check": what a phone needs for a trail to record fully,
 * including with the screen off, as a pure list of rows the UI renders.
 *
 * Platform decisions (see docs/ARCHITECTURE.md › Recording):
 *
 * - **iOS never asks for "Always".** The recording task is started while the
 *   app is in front, with `allowsBackgroundLocationUpdates` and the
 *   `location` background mode, so "While Using the App" keeps fixes flowing
 *   with the screen locked (the blue location pill shows). "Always" would add
 *   App Review friction and a scary prompt for nothing. iOS has no
 *   battery-optimization equivalent that stops a location-mode app.
 * - **iOS precise location** cannot be re-requested in-app: expo-location 56
 *   has no temporary-full-accuracy API, so the fix is the app's Settings page
 *   (Location › Precise Location).
 * - **Android**: precise ("fine") location is re-requested in-app (Android 12+
 *   offers the upgrade in the system dialog); "Allow all the time" is
 *   recommended (the foreground service records without it, but OEM battery
 *   managers spare it more readily); battery restrictions cannot be read
 *   without a native module, so that row is advice, marked done once the user
 *   has reviewed it; notifications (Android 13+) make the recording
 *   notification visible.
 *
 * Kept pure (no react-native/expo): `src/lib/recordingReadiness.ts` reads the
 * permissions and performs the fixes.
 */

export type PermissionState = 'granted' | 'denied' | 'undetermined';

export interface ReadinessSnapshot {
  platform: 'ios' | 'android';
  /** Android API level; iOS major version. */
  osVersion: number;
  /** Lower-cased device manufacturer (Android), '' when unknown. */
  manufacturer: string;
  location: PermissionState;
  locationCanAskAgain: boolean;
  /** iOS accuracy 'full' / Android 'fine'; null when location isn't granted. */
  precise: boolean | null;
  /** Android "Allow all the time" (ignored on iOS — see above). */
  background: PermissionState;
  backgroundCanAskAgain: boolean;
  /** Android 13+ notifications; null where the OS has no runtime permission. */
  notifications: PermissionState | null;
  notificationsCanAskAgain: boolean;
  /** The user has opened the battery settings from this check before. */
  batteryReviewed: boolean;
}

export type ReadinessCheckId = 'location' | 'precise' | 'background' | 'battery' | 'notifications';

/** ok → green; problem → the trail WILL be broken; advice → recommended. */
export type ReadinessStatus = 'ok' | 'problem' | 'advice';

export type ReadinessFix =
  | 'request-location'
  | 'request-precise'
  | 'request-background'
  | 'request-notifications'
  | 'open-app-settings'
  | 'open-battery-settings';

export interface ReadinessCheck {
  id: ReadinessCheckId;
  status: ReadinessStatus;
  title: string;
  detail: string;
  /** What the row's button does; null when there is nothing to do. */
  fix: ReadinessFix | null;
  fixLabel: string | null;
}

/** Android API level from which battery settings live under App info › Battery. */
const ANDROID_APP_BATTERY_PAGE_API = 31;
/** Android API level that introduced the runtime notifications permission. */
export const ANDROID_NOTIFICATIONS_API = 33;

const isSamsung = (s: ReadinessSnapshot) => s.manufacturer.includes('samsung');

function locationRow(s: ReadinessSnapshot): ReadinessCheck {
  if (s.location === 'granted') {
    return {
      id: 'location',
      status: 'ok',
      title: 'Location allowed',
      detail:
        s.platform === 'ios'
          ? '“While Using the App” is enough: recording continues with the screen locked.'
          : 'Inukshuk can use your location while recording.',
      fix: null,
      fixLabel: null,
    };
  }
  const canAsk = s.location === 'undetermined' || s.locationCanAskAgain;
  return {
    id: 'location',
    status: 'problem',
    title: 'Location is off for Inukshuk',
    detail: 'Recording needs your location to draw your trail.',
    fix: canAsk ? 'request-location' : 'open-app-settings',
    fixLabel: canAsk ? 'Allow' : 'Open settings',
  };
}

function preciseRow(s: ReadinessSnapshot): ReadinessCheck | null {
  if (s.location !== 'granted') return null;
  if (s.precise !== false) {
    return {
      id: 'precise',
      status: 'ok',
      title: 'Precise location on',
      detail: 'Your trail is drawn from GPS positions accurate to a few metres.',
      fix: null,
      fixLabel: null,
    };
  }
  if (s.platform === 'ios') {
    return {
      id: 'precise',
      status: 'problem',
      title: 'Precise location is off',
      detail:
        'With approximate location your position is only known to 1–3 km, so no trail can be ' +
        'drawn. In Settings › Location, turn on Precise Location.',
      fix: 'open-app-settings',
      fixLabel: 'Open Settings',
    };
  }
  return {
    id: 'precise',
    status: 'problem',
    title: 'Only approximate location allowed',
    detail:
      'Your position is only known to 1–3 km, so no trail can be drawn. Choose “Precise” ' +
      '(Settings › Permissions › Location › Use precise location).',
    fix: s.locationCanAskAgain ? 'request-precise' : 'open-app-settings',
    fixLabel: s.locationCanAskAgain ? 'Use precise' : 'Open settings',
  };
}

function backgroundRow(s: ReadinessSnapshot): ReadinessCheck | null {
  if (s.platform !== 'android' || s.location !== 'granted') return null;
  if (s.background === 'granted') {
    return {
      id: 'background',
      status: 'ok',
      title: 'Screen-off recording allowed',
      detail: 'Location is set to “Allow all the time”.',
      fix: null,
      fixLabel: null,
    };
  }
  const canAsk = s.background === 'undetermined' || s.backgroundCanAskAgain;
  return {
    id: 'background',
    status: 'advice',
    title: 'Allow location all the time',
    detail:
      'Recording keeps going with the screen off, but Android stops apps limited to “While ' +
      'using the app” more readily. Choose “Allow all the time”. It is only used while you record.',
    fix: canAsk ? 'request-background' : 'open-app-settings',
    fixLabel: 'Change',
  };
}

function batteryRow(s: ReadinessSnapshot): ReadinessCheck | null {
  if (s.platform !== 'android') return null;
  const where =
    s.osVersion >= ANDROID_APP_BATTERY_PAGE_API
      ? 'Set Battery to “Unrestricted” on the next screen'
      : 'Choose “Don’t optimize” for Inukshuk on the next screen';
  const samsung = isSamsung(s)
    ? ' On Samsung, also open Settings › Battery › Background usage limits and add Inukshuk to ' +
      '“Never sleeping apps”.'
    : '';
  return {
    id: 'battery',
    status: s.batteryReviewed ? 'ok' : 'advice',
    title: s.batteryReviewed ? 'Battery settings reviewed' : 'Let GPS run with the screen off',
    detail: `Battery savers can stop GPS in your pocket. ${where}.${samsung}`,
    fix: 'open-battery-settings',
    fixLabel: s.batteryReviewed ? 'Review' : 'Open',
  };
}

function notificationsRow(s: ReadinessSnapshot): ReadinessCheck | null {
  if (s.platform !== 'android' || s.notifications === null) return null;
  if (s.notifications === 'granted') {
    return {
      id: 'notifications',
      status: 'ok',
      title: 'Recording notification shown',
      detail: 'A notification shows while a recording runs.',
      fix: null,
      fixLabel: null,
    };
  }
  const canAsk = s.notifications === 'undetermined' || s.notificationsCanAskAgain;
  return {
    id: 'notifications',
    status: 'advice',
    title: 'Show the recording notification',
    detail: 'Allow notifications so you can see that recording is running with the screen off.',
    fix: canAsk ? 'request-notifications' : 'open-app-settings',
    fixLabel: 'Allow',
  };
}

/** The rows of the Recording check, in display order. */
export function readinessChecks(s: ReadinessSnapshot): ReadinessCheck[] {
  return [
    locationRow(s),
    preciseRow(s),
    backgroundRow(s),
    batteryRow(s),
    notificationsRow(s),
  ].filter((c): c is ReadinessCheck => c !== null);
}

/** True when a row says the trail WILL be broken (not merely at risk). */
export function hasProblem(checks: readonly ReadinessCheck[]): boolean {
  return checks.some((c) => c.status === 'problem');
}

/** True when every row is green. */
export function allClear(checks: readonly ReadinessCheck[]): boolean {
  return checks.every((c) => c.status === 'ok');
}
