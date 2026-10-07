import {
  ANDROID_NOTIFICATIONS_API,
  type PermissionState,
  type ReadinessFix,
  type ReadinessSnapshot,
} from '@core/recording/recordingReadiness';
import * as Location from 'expo-location';
import { Linking, PermissionsAndroid, Platform } from 'react-native';

/**
 * Platform half of the Recording check (`@core/recording/recordingReadiness`):
 * reads what the OS has granted and performs a row's fix. Every call is
 * guarded — a permission API that throws (old binary, missing manifest entry)
 * must never break the record flow; it reads as "not granted".
 */

/** Android 13+ notifications permission, persisted across the app's life by
 * the OS. `PermissionsAndroid.check` cannot tell "never asked" from "denied",
 * and only `request` reports "never_ask_again" — remember the last answer. */
let notificationsBlocked = false;

/** Test-only: forget module state. */
export function resetRecordingReadinessForTests(): void {
  notificationsBlocked = false;
}

function toState(p: { granted: boolean; status: string }): PermissionState {
  if (p.granted) return 'granted';
  return p.status === 'undetermined' ? 'undetermined' : 'denied';
}

function osVersion(): number {
  const v = Platform.Version;
  return typeof v === 'number' ? v : parseInt(String(v), 10) || 0;
}

function manufacturer(): string {
  if (Platform.OS !== 'android') return '';
  const c = Platform.constants as { Manufacturer?: unknown; Brand?: unknown };
  return `${typeof c.Manufacturer === 'string' ? c.Manufacturer : ''} ${
    typeof c.Brand === 'string' ? c.Brand : ''
  }`
    .trim()
    .toLowerCase();
}

/** True where Android has a runtime notifications permission (API 33+). */
function hasNotificationsPermission(): boolean {
  return Platform.OS === 'android' && osVersion() >= ANDROID_NOTIFICATIONS_API;
}

/**
 * Android 13+ suppresses ALL notifications — including the recording
 * foreground service's — unless POST_NOTIFICATIONS is granted at runtime.
 * Asked when a recording starts (the moment the notification matters); a
 * denial degrades to an invisible-but-running service, never an error. On
 * binaries whose manifest lacks the permission (≤ vc45) the request resolves
 * as denied immediately — harmless.
 */
export async function requestNotificationsForRecording(): Promise<void> {
  if (!hasNotificationsPermission() || notificationsBlocked) return;
  try {
    const res = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    if (res === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) notificationsBlocked = true;
  } catch {
    /* never block recording on the notification prompt */
  }
}

/** Read everything the Recording check shows. */
export async function readReadinessSnapshot(batteryReviewed: boolean): Promise<ReadinessSnapshot> {
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  let location: PermissionState = 'denied';
  let locationCanAskAgain = false;
  let precise: boolean | null = null;
  try {
    const fg = await Location.getForegroundPermissionsAsync();
    location = toState(fg);
    locationCanAskAgain = fg.canAskAgain;
    if (fg.granted) {
      precise =
        platform === 'ios'
          ? fg.ios
            ? fg.ios.accuracy === 'full'
            : null
          : fg.android
            ? fg.android.accuracy === 'fine'
            : null;
    }
  } catch {
    /* reads as denied */
  }
  let background: PermissionState = 'denied';
  let backgroundCanAskAgain = false;
  if (platform === 'android') {
    try {
      const bg = await Location.getBackgroundPermissionsAsync();
      background = toState(bg);
      backgroundCanAskAgain = bg.canAskAgain;
    } catch {
      /* e.g. ACCESS_BACKGROUND_LOCATION absent from an old manifest */
    }
  }
  let notifications: PermissionState | null = null;
  if (hasNotificationsPermission()) {
    try {
      const granted = await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
      );
      notifications = granted ? 'granted' : 'denied';
    } catch {
      notifications = 'denied';
    }
  }
  return {
    platform,
    osVersion: osVersion(),
    manufacturer: manufacturer(),
    location,
    locationCanAskAgain,
    precise,
    background,
    backgroundCanAskAgain,
    notifications,
    notificationsCanAskAgain: !notificationsBlocked,
    batteryReviewed,
  };
}

/** True when location is granted but only approximately; null when unknown. */
export async function isApproximateLocation(): Promise<boolean | null> {
  try {
    const fg = await Location.getForegroundPermissionsAsync();
    if (!fg.granted) return null;
    if (Platform.OS === 'ios') return fg.ios ? fg.ios.accuracy === 'reduced' : null;
    return fg.android ? fg.android.accuracy !== 'fine' : null;
  } catch {
    return null;
  }
}

async function openAppSettings(): Promise<void> {
  try {
    await Linking.openSettings();
  } catch {
    /* nothing more we can do */
  }
}

/**
 * Battery restrictions. Android 12+ keeps the per-app "Unrestricted" choice on
 * the app's own info page (App info › Battery), which is also where Samsung
 * lands; older Android lists apps under the battery-optimization screen
 * (ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS needs no permission — we
 * deliberately do NOT declare REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, a Play
 * policy risk for a non-exempt app category).
 */
async function openBatterySettings(): Promise<void> {
  if (Platform.OS === 'android' && osVersion() < 31) {
    try {
      await Linking.sendIntent('android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS');
      return;
    } catch {
      /* fall back to the app page */
    }
  }
  await openAppSettings();
}

/** Perform a Recording-check row's fix. Resolves once the OS answered (or the
 * settings page was opened); the caller re-reads the snapshot afterwards. */
export async function applyReadinessFix(fix: ReadinessFix): Promise<void> {
  try {
    switch (fix) {
      case 'request-location':
      case 'request-precise': {
        // Android 12+: re-requesting FINE while only COARSE is held shows the
        // "change to precise" dialog. A blocked dialog resolves without a
        // prompt; then the settings page is the only way left.
        const res = await Location.requestForegroundPermissionsAsync();
        const stillMissing =
          !res.granted ||
          (fix === 'request-precise' &&
            (Platform.OS === 'ios'
              ? res.ios?.accuracy === 'reduced'
              : res.android?.accuracy !== 'fine'));
        if (stillMissing && !res.canAskAgain) await openAppSettings();
        return;
      }
      case 'request-background': {
        // Android 11+ answers this by opening the app's location page, where
        // the user picks "Allow all the time".
        const res = await Location.requestBackgroundPermissionsAsync();
        if (!res.granted && !res.canAskAgain) await openAppSettings();
        return;
      }
      case 'request-notifications': {
        const res = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
        );
        if (res === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
          notificationsBlocked = true;
          await openAppSettings();
        }
        return;
      }
      case 'open-battery-settings':
        await openBatterySettings();
        return;
      case 'open-app-settings':
        await openAppSettings();
        return;
    }
  } catch {
    // A request that throws (missing manifest entry on an old binary) leaves
    // the settings page as the honest fallback.
    await openAppSettings();
  }
}
