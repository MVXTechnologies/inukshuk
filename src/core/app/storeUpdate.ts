/**
 * The in-app "New version" prompt (2.7.0): when the store holds a newer
 * binary than the one running, the Map shows one quiet line with an Update
 * button. JS-only fixes keep arriving silently over the air (expo-updates);
 * this is only for releases that need the store.
 *
 * Pure decisions only — version order, the once-a-day check throttle, the
 * per-version dismissal and when the prompt may be on screen. The store
 * calls live in `@data/storeUpdate`, the native Play bridge in
 * `@lib/playAppUpdate`.
 */

/** At most one store check per this long (and at most one per launch). */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** A newer binary in the store. */
export type StoreOffer =
  | {
      platform: 'ios';
      /** The App Store's `version` (CFBundleShortVersionString), e.g. "2.7.1". */
      version: string;
      /** Numeric App Store id, for the store page. */
      trackId: number;
    }
  | {
      platform: 'android';
      /** Google Play's `availableVersionCode`; Play does not hand out the name. */
      versionCode: number;
    };

/** What the running binary is: the native version and build, not the OTA's. */
export interface RunningBinary {
  /** "2.7.0"; null when unknown. */
  version: string | null;
  /** The build number (Android: versionCode); null when unknown. */
  build: string | null;
}

/** Persisted between launches (`update-check.json`). */
export interface UpdateCheckState {
  /** When the store last answered (epoch ms); a failed check leaves it. */
  lastCheckAt: number | null;
  /** The last offer the store made, shown again until it is installed. */
  offer: StoreOffer | null;
  /** The offer (by {@link offerKey}) the person closed: never shown again. */
  dismissed: string | null;
  /**
   * Android: the person accepted Play's download and it has not been
   * installed yet. The next launch asks Play again (its answer is local), so
   * "Restart to update" comes back after the app was closed mid-download.
   */
  downloadPending: boolean;
}

export const EMPTY_UPDATE_CHECK_STATE: UpdateCheckState = {
  lastCheckAt: null,
  offer: null,
  dismissed: null,
  downloadPending: false,
};

/**
 * Dotted numeric version order: -1, 0 or 1, or null when either side is not
 * a plain `1.2.3` (a pre-release tag, junk). Missing parts count as 0, so
 * "2.7" equals "2.7.0".
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null || pb === null) return null;
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

function parseVersion(v: string): number[] | null {
  const s = v.trim();
  if (!/^\d+(\.\d+){0,3}$/.test(s)) return null;
  return s.split('.').map(Number);
}

/** True only when `store` is a strictly later version than `running`. */
export function isNewerVersion(store: string, running: string): boolean {
  return compareVersions(store, running) === 1;
}

/** The identity a dismissal is remembered by: one per store version. */
export function offerKey(offer: StoreOffer): string {
  return offer.platform === 'ios' ? `ios:${offer.version}` : `android:${offer.versionCode}`;
}

/**
 * Whether to ask the store now: never twice in one launch, then once a day —
 * or at the next launch while an accepted Play download is not installed.
 * A clock that moved backwards (the last check is "in the future") counts as
 * due, so a wrong date cannot silence the check for good.
 */
export function isUpdateCheckDue(
  state: Pick<UpdateCheckState, 'lastCheckAt' | 'downloadPending'>,
  now: number,
  checkedThisLaunch: boolean,
): boolean {
  if (checkedThisLaunch) return false;
  if (state.downloadPending) return true;
  const { lastCheckAt } = state;
  if (lastCheckAt === null || !Number.isFinite(lastCheckAt)) return true;
  if (lastCheckAt > now) return true;
  return now - lastCheckAt >= UPDATE_CHECK_INTERVAL_MS;
}

/**
 * Whether an offer (fresh or remembered) is still newer than what runs: a
 * remembered one goes stale the moment the update is installed.
 */
export function isOfferNewer(offer: StoreOffer, running: RunningBinary): boolean {
  if (offer.platform === 'ios') {
    return running.version !== null && isNewerVersion(offer.version, running.version);
  }
  const build = running.build === null ? NaN : Number(running.build);
  return Number.isInteger(build) && offer.versionCode > build;
}

/** The App Store lookup's one useful result, or null for anything else. */
export interface ItunesLookup {
  version: string;
  trackId: number;
  /** The lowest iOS the store version runs on ("17.0"), or null. */
  minimumOsVersion: string | null;
}

/** Parse `https://itunes.apple.com/lookup?bundleId=…` defensively. */
export function parseItunesLookup(raw: unknown): ItunesLookup | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const results = (raw as { results?: unknown }).results;
  if (!Array.isArray(results)) return null;
  const first: unknown = results[0];
  if (typeof first !== 'object' || first === null) return null;
  const r = first as { version?: unknown; trackId?: unknown; minimumOsVersion?: unknown };
  if (typeof r.version !== 'string' || parseVersion(r.version) === null) return null;
  if (typeof r.trackId !== 'number' || !Number.isSafeInteger(r.trackId) || r.trackId <= 0) {
    return null;
  }
  return {
    version: r.version.trim(),
    trackId: r.trackId,
    minimumOsVersion: typeof r.minimumOsVersion === 'string' ? r.minimumOsVersion : null,
  };
}

/**
 * The iPhone offer from a lookup: only a strictly newer version, and only
 * one this iOS can install (a store build that needs a newer iOS than the
 * phone has would open a page with no Update button).
 */
export function iosOfferFromLookup(
  lookup: ItunesLookup | null,
  running: RunningBinary,
  osVersion: string,
): StoreOffer | null {
  if (lookup === null) return null;
  const offer: StoreOffer = { platform: 'ios', version: lookup.version, trackId: lookup.trackId };
  if (!isOfferNewer(offer, running)) return null;
  if (lookup.minimumOsVersion !== null) {
    const fits = compareVersions(osVersion, lookup.minimumOsVersion);
    if (fits === -1) return null;
  }
  return offer;
}

/** The App Store page for an offer (opened by the Update button). */
export function appStoreUrl(trackId: number): string {
  return `https://apps.apple.com/app/id${trackId}`;
}

/** Google Play's listing, for a phone where in-app updates are unavailable. */
export function playStoreUrls(packageName: string): { market: string; web: string } {
  const id = encodeURIComponent(packageName);
  return {
    market: `market://details?id=${id}`,
    web: `https://play.google.com/store/apps/details?id=${id}`,
  };
}

/** Where the Android in-app update is (Play's flexible flow). */
export type UpdatePhase =
  { kind: 'available' } | { kind: 'downloading'; fraction: number | null } | { kind: 'downloaded' };

/** Play's install status codes (`InstallStatus`) that matter here. */
export const PLAY_INSTALL_STATUS = {
  PENDING: 1,
  DOWNLOADING: 2,
  INSTALLING: 3,
  INSTALLED: 4,
  FAILED: 5,
  CANCELED: 6,
  DOWNLOADED: 11,
} as const;

/**
 * The phase a Play install-state event moves the prompt to. A failed or
 * cancelled download goes back to offering the update.
 */
export function phaseFromPlayStatus(
  status: number,
  bytesDownloaded: number,
  totalBytes: number,
): UpdatePhase | null {
  switch (status) {
    case PLAY_INSTALL_STATUS.PENDING:
    case PLAY_INSTALL_STATUS.DOWNLOADING: {
      const fraction =
        totalBytes > 0 && bytesDownloaded >= 0 ? Math.min(1, bytesDownloaded / totalBytes) : null;
      return { kind: 'downloading', fraction };
    }
    case PLAY_INSTALL_STATUS.DOWNLOADED:
      return { kind: 'downloaded' };
    case PLAY_INSTALL_STATUS.FAILED:
    case PLAY_INSTALL_STATUS.CANCELED:
      return { kind: 'available' };
    default:
      return null;
  }
}

/**
 * The prompt's one line and its button (none while downloading), with the
 * button's spoken label. Short on purpose: line and button stay on one row
 * at 360 dp at every Display size with the OS font at its cap
 * (`UpdatePromptBanner.test.tsx` measures it). Play gives a versionCode, not
 * a name, so Android says "New version".
 */
export function updatePromptCopy(
  offer: StoreOffer,
  phase: UpdatePhase,
): { text: string; action: string | null; actionLabel: string | null } {
  if (phase.kind === 'downloaded') {
    return { text: 'Update downloaded', action: 'Restart', actionLabel: 'Restart to update' };
  }
  if (phase.kind === 'downloading') {
    const pct = phase.fraction === null ? '' : ` · ${Math.round(phase.fraction * 100)} %`;
    return { text: `Downloading update${pct}`, action: null, actionLabel: null };
  }
  return {
    text: offer.platform === 'ios' ? `Version ${offer.version} available` : 'New version available',
    action: 'Update',
    actionLabel: 'Update Inukshuk',
  };
}

/**
 * Whether the prompt may be on screen: an offer the person has not closed,
 * and never while a trail is being recorded or an SOS is live.
 */
export function isUpdatePromptVisible(input: {
  offer: StoreOffer | null;
  dismissed: string | null;
  recording: boolean;
  sosActive: boolean;
}): boolean {
  if (input.offer === null) return false;
  if (input.recording || input.sosActive) return false;
  return input.dismissed !== offerKey(input.offer);
}

function sanitizeOffer(raw: unknown): StoreOffer | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as {
    platform?: unknown;
    version?: unknown;
    trackId?: unknown;
    versionCode?: unknown;
  };
  if (
    o.platform === 'ios' &&
    typeof o.version === 'string' &&
    parseVersion(o.version) !== null &&
    typeof o.trackId === 'number' &&
    Number.isSafeInteger(o.trackId) &&
    o.trackId > 0
  ) {
    return { platform: 'ios', version: o.version, trackId: o.trackId };
  }
  if (
    o.platform === 'android' &&
    typeof o.versionCode === 'number' &&
    Number.isSafeInteger(o.versionCode) &&
    o.versionCode > 0
  ) {
    return { platform: 'android', versionCode: o.versionCode };
  }
  return null;
}

/** Read `update-check.json` defensively: junk fields fall back to empty. */
export function sanitizeUpdateCheckState(raw: unknown): UpdateCheckState {
  if (typeof raw !== 'object' || raw === null) return EMPTY_UPDATE_CHECK_STATE;
  const r = raw as {
    lastCheckAt?: unknown;
    offer?: unknown;
    dismissed?: unknown;
    downloadPending?: unknown;
  };
  return {
    lastCheckAt:
      typeof r.lastCheckAt === 'number' && Number.isFinite(r.lastCheckAt) ? r.lastCheckAt : null,
    offer: sanitizeOffer(r.offer),
    dismissed: typeof r.dismissed === 'string' ? r.dismissed : null,
    downloadPending: r.downloadPending === true,
  };
}
