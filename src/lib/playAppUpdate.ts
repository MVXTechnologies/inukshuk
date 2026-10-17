/**
 * The JS face of Google Play In-App Updates (modules/inukshuk-app-update,
 * Android only). Optional: off Android, and on a binary without the module,
 * every call answers "nothing" and the prompt stays away. Never throws past
 * {@link playUpdateInfo}'s null; the start/complete calls reject so the
 * caller can fall back to the Play listing.
 */
import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

/** What Play says about this app (raw codes; `@core/app/storeUpdate` reads them). */
export interface PlayUpdateInfo {
  /** `UpdateAvailability`: 2 = available, 3 = an update we started is running. */
  availability: number;
  versionCode: number;
  /** `InstallStatus` of an update already under way (11 = downloaded). */
  installStatus: number;
  flexibleAllowed: boolean;
  bytesDownloaded: number;
  totalBytes: number;
}

export interface PlayInstallState {
  status: number;
  bytesDownloaded: number;
  totalBytes: number;
}

interface NativePlayUpdate {
  check(): Promise<PlayUpdateInfo>;
  startFlexible(): Promise<boolean>;
  completeUpdate(): Promise<void>;
  addListener(event: 'onState', listener: (state: PlayInstallState) => void): { remove(): void };
}

/** Play's `UpdateAvailability` codes. */
export const PLAY_AVAILABILITY = { AVAILABLE: 2, IN_PROGRESS: 3 } as const;

function nativeModule(): NativePlayUpdate | null {
  if (Platform.OS !== 'android') return null;
  try {
    return requireOptionalNativeModule<NativePlayUpdate>('InukshukAppUpdate');
  } catch {
    return null;
  }
}

/** Whether this binary can update itself through Play. */
export function playUpdateSupported(): boolean {
  return nativeModule() !== null;
}

/** Play's answer, or null without Play (sideload, no Store, no account, offline). */
export async function playUpdateInfo(): Promise<PlayUpdateInfo | null> {
  const native = nativeModule();
  if (native === null) return null;
  try {
    return await native.check();
  } catch {
    return null;
  }
}

/**
 * Play's own "Update?" sheet, then the background download. True when the
 * person accepted; false when they declined. Rejects when Play cannot run a
 * flexible update here (the caller opens the listing instead).
 */
export async function startPlayFlexibleUpdate(): Promise<boolean> {
  const native = nativeModule();
  if (native === null) throw new Error('In-app updates unavailable');
  return native.startFlexible();
}

/** Install the downloaded update: Play restarts the app. */
export async function completePlayUpdate(): Promise<void> {
  const native = nativeModule();
  if (native === null) throw new Error('In-app updates unavailable');
  await native.completeUpdate();
}

/** Download progress and completion; a no-op unsubscribe without the module. */
export function onPlayInstallState(listener: (state: PlayInstallState) => void): () => void {
  const native = nativeModule();
  if (native === null) return () => {};
  const sub = native.addListener('onState', listener);
  return () => sub.remove();
}
