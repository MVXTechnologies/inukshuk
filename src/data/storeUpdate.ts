import * as Application from 'expo-application';
import { Linking, Platform } from 'react-native';

import {
  appStoreUrl,
  iosOfferFromLookup,
  parseItunesLookup,
  phaseFromPlayStatus,
  playStoreUrls,
  sanitizeUpdateCheckState,
  type RunningBinary,
  type StoreOffer,
  type UpdateCheckState,
  type UpdatePhase,
} from '@core/app/storeUpdate';
import {
  PLAY_AVAILABILITY,
  completePlayUpdate,
  playUpdateInfo,
  startPlayFlexibleUpdate,
} from '@lib/playAppUpdate';

import * as storage from './storage';

/**
 * The store side of the "New version" prompt (2.7.0): what the store holds,
 * and the Update button's target. Every failure — offline, "Locally
 * downloaded only", no Play Store, a slow or broken answer — is `null`, and
 * the prompt simply does not appear.
 */

const STATE_FILE = 'update-check.json';
const LOOKUP_TIMEOUT_MS = 10_000;

/** The binary actually running (an over-the-air bundle never changes these). */
export function runningBinary(): RunningBinary {
  return {
    version: Application.nativeApplicationVersion,
    build: Application.nativeBuildVersion,
  };
}

export async function readUpdateCheckState(): Promise<UpdateCheckState> {
  try {
    return sanitizeUpdateCheckState(await storage.readJson<unknown>(STATE_FILE));
  } catch {
    return sanitizeUpdateCheckState(null);
  }
}

export function saveUpdateCheckState(state: UpdateCheckState): void {
  try {
    storage.writeJson(STATE_FILE, state);
  } catch {
    // A full disk costs at most one more check or one more prompt.
  }
}

/** The store's answer: an offer (or none), with Play's download phase if one runs. */
export interface StoreAnswer {
  offer: StoreOffer | null;
  phase: UpdatePhase;
}

async function lookupAppStore(bundleId: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const url = `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(bundleId)}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`lookup failed: HTTP ${res.status}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the store once. Null when it could not answer (the throttle then does
 * not count this as a check); `{ offer: null }` when it answered "nothing new".
 */
export async function fetchStoreAnswer(): Promise<StoreAnswer | null> {
  // "Locally downloaded only" means no network at all, not even this.
  if (!storage.isNetworkAllowed()) return null;
  const running = runningBinary();
  try {
    if (Platform.OS === 'ios') {
      const bundleId = Application.applicationId;
      if (bundleId === null) return null;
      const lookup = parseItunesLookup(await lookupAppStore(bundleId));
      const offer = iosOfferFromLookup(lookup, running, String(Platform.Version));
      return { offer, phase: { kind: 'available' } };
    }
    if (Platform.OS === 'android') {
      const info = await playUpdateInfo();
      if (info === null) return null;
      const offered =
        info.availability === PLAY_AVAILABILITY.AVAILABLE ||
        info.availability === PLAY_AVAILABILITY.IN_PROGRESS;
      if (!offered || !Number.isSafeInteger(info.versionCode) || info.versionCode <= 0) {
        return { offer: null, phase: { kind: 'available' } };
      }
      const phase =
        phaseFromPlayStatus(info.installStatus, info.bytesDownloaded, info.totalBytes) ??
        ({ kind: 'available' } as const);
      return { offer: { platform: 'android', versionCode: info.versionCode }, phase };
    }
  } catch {
    // Offline, timed out, or a broken answer: no prompt this time.
  }
  return null;
}

async function openFirst(urls: readonly string[]): Promise<boolean> {
  for (const url of urls) {
    try {
      await Linking.openURL(url);
      return true;
    } catch {
      // Try the next form (the app-store scheme, then the web page).
    }
  }
  return false;
}

/** The store page for the app: App Store on iPhone, the Play listing on Android. */
export function openStorePage(offer: StoreOffer): Promise<boolean> {
  if (offer.platform === 'ios') {
    const web = appStoreUrl(offer.trackId);
    return openFirst([web.replace(/^https:/, 'itms-apps:'), web]);
  }
  const id = Application.applicationId;
  if (id === null) return Promise.resolve(false);
  const { market, web } = playStoreUrls(id);
  return openFirst([market, web]);
}

/**
 * The Update button. iPhone: the App Store page. Android: Play's in-app
 * flexible update (resolves `'started'` when the download began), or the Play
 * listing when Play cannot run it (resolves `'store'`).
 */
export async function startStoreUpdate(
  offer: StoreOffer,
): Promise<'started' | 'declined' | 'store' | 'failed'> {
  if (offer.platform === 'android') {
    try {
      return (await startPlayFlexibleUpdate()) ? 'started' : 'declined';
    } catch {
      // Fall through to the listing.
    }
  }
  return (await openStorePage(offer)) ? 'store' : 'failed';
}

/** "Restart to update": Play installs the downloaded update and restarts the app. */
export async function installDownloadedUpdate(): Promise<boolean> {
  try {
    await completePlayUpdate();
    return true;
  } catch {
    return false;
  }
}
