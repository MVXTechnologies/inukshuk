import {
  STRAVA_DEAUTHORIZE_URL,
  STRAVA_TOKEN_URL,
  STRAVA_UPLOADS_URL,
  authRedirectOutcome,
  buildAuthorizeUrl,
  buildTokenExchangeBody,
  buildTokenRefreshBody,
  formEncode,
  isStravaAuthRedirect,
} from '@core/strava/oauth';
import { isTokenFresh, parseTokenResponse } from '@core/strava/tokens';
import {
  buildUploadFields,
  classifyUploadResponse,
  nextPollDelayMs,
  type UploadOutcome,
} from '@core/strava/upload';
import { reportError } from '@lib/errorReporting';
import { useStravaStore } from '@state/stravaStore';
import Constants from 'expo-constants';
import * as Linking from 'expo-linking';
import { nanoid } from 'nanoid/non-secure';
import { AppState } from 'react-native';

/**
 * Platform/network half of the Strava integration: the OAuth connect flow
 * (browser round-trip via the app scheme — no expo-web-browser/expo-auth-session
 * native dependency, so this stays OTA-able), token refresh with rotation,
 * the GPX upload + status polling, and deauthorization. All the decision logic
 * (URL/body building, response classification, expiry math) is pure and tested
 * in `@core/strava/*`.
 */

// --- configuration -----------------------------------------------------------

export interface StravaConfig {
  clientId: string;
  clientSecret: string;
}

function extraString(key: 'stravaClientId' | 'stravaClientSecret'): string | undefined {
  const value: unknown = Constants.expoConfig?.extra?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Strava API credentials baked into this build (`extra.stravaClientId/Secret`
 * from the STRAVA_CLIENT_ID/STRAVA_CLIENT_SECRET env — see docs/DEPLOYMENT.md
 * § Strava), or null when this build was made without them.
 */
export function getStravaConfig(): StravaConfig | null {
  const clientId = extraString('stravaClientId');
  const clientSecret = extraString('stravaClientSecret');
  if (clientId === undefined || clientSecret === undefined) return null;
  return { clientId, clientSecret };
}

export function isStravaConfigured(): boolean {
  return getStravaConfig() !== null;
}

// --- OAuth connect flow ------------------------------------------------------

/**
 * Resolver for the in-flight connect attempt, waiting on the browser redirect.
 * Deep links reach us through {@link handleStravaAuthRedirect}, called from
 * `app/+native-intent.tsx` (the OS intent path) and a `Linking` listener
 * (the warm-app path) — both may fire for one redirect; resolving is one-shot.
 */
let pendingRedirect: ((url: string) => void) | null = null;

/**
 * Feed an incoming deep link to the connect flow. Returns true when the URL was
 * the Strava OAuth redirect (whether or not a connect attempt was waiting).
 */
export function handleStravaAuthRedirect(url: string): boolean {
  if (!isStravaAuthRedirect(url)) return false;
  const resolve = pendingRedirect;
  pendingRedirect = null;
  resolve?.(url);
  return true;
}

export type ConnectOutcome = { ok: true; athleteName: string } | { ok: false; message: string };

/** Returning from the browser without the redirect = the user backed out. */
const CANCEL_GRACE_MS = 12_000;
/** Give up on the whole browser round-trip after this long. */
const CONNECT_TIMEOUT_MS = 4 * 60_000;

const REDIRECT_FAILURES: Record<string, string> = {
  denied: 'Strava access was declined',
  'state-mismatch': 'Strava sign-in could not be verified — try again',
  'missing-scope': 'Inukshuk needs the "Upload your activities" permission on Strava',
  malformed: 'Strava sent back an unusable response — try again',
};

/**
 * Run the full connect flow: open the system browser on Strava's authorize
 * page, wait for the `inukshuk://` redirect, exchange the code for tokens
 * (client secret — Strava has no PKCE) and store the connection. Resolves with
 * a user-presentable outcome; never throws.
 */
export async function connectStrava(): Promise<ConnectOutcome> {
  const config = getStravaConfig();
  if (!config) return { ok: false, message: 'Strava is not configured in this build' };
  if (pendingRedirect !== null) return { ok: false, message: 'A Strava sign-in is already open' };

  const state = nanoid(16);

  const redirectUrl = await new Promise<string | null>((resolve) => {
    let done = false;
    let cancelGrace: ReturnType<typeof setTimeout> | undefined;

    // One-shot settle: every path (redirect, cancel grace, timeout, open
    // failure) cleans up the listeners and timers.
    const settle = (url: string | null) => {
      if (done) return;
      done = true;
      pendingRedirect = null;
      linkSub.remove();
      appStateSub.remove();
      clearTimeout(cancelGrace);
      clearTimeout(hardTimeout);
      resolve(url);
    };

    pendingRedirect = settle;
    // Warm-app redirects (browser overlay closes back onto the running app).
    const linkSub = Linking.addEventListener('url', (event) => {
      handleStravaAuthRedirect(event.url);
    });
    // The user coming back to the app WITHOUT the redirect (browser back
    // button) would otherwise leave the row spinning until the hard timeout.
    // A real redirect lands within moments of activation and clears the grace.
    const appStateSub = AppState.addEventListener('change', (appState) => {
      if (appState === 'active' && !done) {
        clearTimeout(cancelGrace);
        cancelGrace = setTimeout(() => settle(null), CANCEL_GRACE_MS);
      }
    });
    const hardTimeout = setTimeout(() => settle(null), CONNECT_TIMEOUT_MS);

    Linking.openURL(buildAuthorizeUrl({ clientId: config.clientId, state })).catch(() =>
      settle(null),
    );
  });

  if (redirectUrl === null) return { ok: false, message: 'Strava sign-in was cancelled' };

  const outcome = authRedirectOutcome(redirectUrl, state);
  if (!outcome.ok) {
    return { ok: false, message: REDIRECT_FAILURES[outcome.reason] ?? 'Strava sign-in failed' };
  }

  try {
    const response = await fetch(STRAVA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: buildTokenExchangeBody({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        code: outcome.code,
      }),
    });
    const json: unknown = await response.json().catch(() => null);
    const parsed = response.ok ? parseTokenResponse(json) : null;
    if (!parsed) {
      return { ok: false, message: `Strava sign-in failed (HTTP ${response.status})` };
    }
    useStravaStore.getState().setConnection({
      ...parsed.tokens,
      athleteId: parsed.athlete?.id ?? null,
      athleteName: parsed.athlete?.name ?? '',
    });
    return { ok: true, athleteName: parsed.athlete?.name ?? '' };
  } catch (err) {
    reportError(err, 'strava-connect');
    return { ok: false, message: 'Could not reach Strava — check your connection' };
  }
}

// --- token refresh (with rotation) ------------------------------------------

/** Single-flight: concurrent refreshes would burn the rotated refresh token. */
let refreshInFlight: Promise<string> | null = null;

/**
 * A usable access token for API calls, refreshing (and rotating the refresh
 * token) when the stored one is stale. Throws with a user-presentable message
 * when disconnected, offline, or revoked (revocation also clears the stored
 * connection so Settings reflects reality).
 */
async function freshAccessToken(): Promise<string> {
  const store = useStravaStore.getState();
  const connection = store.connection;
  if (!connection) throw new Error('not connected to Strava');
  if (isTokenFresh(connection.expiresAt, Date.now())) return connection.accessToken;

  const config = getStravaConfig();
  if (!config) throw new Error('Strava is not configured in this build');

  refreshInFlight ??= (async () => {
    let response: Response;
    try {
      response = await fetch(STRAVA_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: buildTokenRefreshBody({
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          refreshToken: connection.refreshToken,
        }),
      });
    } catch {
      throw new Error('could not reach Strava — check your connection');
    }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      // The refresh token is no longer honored (the athlete revoked access on
      // strava.com, or credentials changed). Forget the dead connection.
      useStravaStore.getState().clearConnection();
      throw new Error('Strava connection expired — reconnect in Settings');
    }
    const json: unknown = await response.json().catch(() => null);
    const parsed = response.ok ? parseTokenResponse(json) : null;
    if (!parsed) throw new Error(`Strava token refresh failed (HTTP ${response.status})`);
    // ALWAYS store the rotated refresh token — the old one just stopped working.
    useStravaStore.getState().setTokens(parsed.tokens);
    return parsed.tokens.accessToken;
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

// --- upload ------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What the upload needs to know about a saved trail. */
export interface UploadableTrack {
  id: string;
  name: string;
  /** Absolute file:// uri of the saved GPX. */
  fileUri: string;
}

/**
 * Upload a saved GPX to Strava (multipart, `data_type=gpx`, activity named
 * after the trail) and poll the upload status briefly until it settles.
 * Resolves with an {@link UploadOutcome}; never throws — feed the result to
 * `describeUploadOutcome` for the snackbar line.
 */
export async function uploadTrackToStrava(track: UploadableTrack): Promise<UploadOutcome> {
  let token: string;
  try {
    token = await freshAccessToken();
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }

  try {
    const form = new FormData();
    for (const [key, value] of Object.entries(buildUploadFields(track.name, track.id))) {
      form.append(key, value);
    }
    // React Native's FormData takes a { uri, name, type } file descriptor and
    // streams the file from disk (its types call it a Blob).
    form.append('file', {
      uri: track.fileUri,
      name: `${track.id}.gpx`,
      type: 'application/gpx+xml',
    } as unknown as Blob);

    const response = await fetch(STRAVA_UPLOADS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        response.status === 401 || response.status === 403
          ? 'Strava rejected the connection — reconnect in Settings'
          : `Strava refused the upload (HTTP ${response.status})`;
      return { kind: 'error', message };
    }

    let status = classifyUploadResponse(json);
    for (let attempt = 0; status.kind === 'processing'; attempt += 1) {
      const delay = nextPollDelayMs(attempt);
      // Still processing after the whole schedule: the upload was accepted —
      // report "still processing" rather than a scary failure.
      if (delay === null) return { kind: 'timeout' };
      await sleep(delay);
      const poll = await fetch(`${STRAVA_UPLOADS_URL}/${status.uploadId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!poll.ok) return { kind: 'timeout' }; // accepted; just can't confirm
      status = classifyUploadResponse(await poll.json().catch(() => null));
    }
    if (status.kind === 'ready') return { kind: 'ready' };
    if (status.kind === 'duplicate') return { kind: 'duplicate' };
    return status;
  } catch (err) {
    reportError(err, 'strava-upload');
    return { kind: 'error', message: 'could not reach Strava — check your connection' };
  }
}

// --- disconnect --------------------------------------------------------------

/**
 * Disconnect: revoke the app's access on Strava's side (deauthorize) and
 * forget the stored connection locally. The local forget always happens;
 * `revoked` reports whether Strava confirmed the revocation (when it didn't,
 * the athlete can also remove Inukshuk at strava.com/settings/apps).
 */
export async function disconnectStrava(): Promise<{ revoked: boolean }> {
  const store = useStravaStore.getState();
  const connection = store.connection;
  if (!connection) return { revoked: true };

  // Deauthorize needs a live access token; refresh best-effort first. A
  // refresh failure may already have cleared the connection (revoked upstream)
  // — that's fine, revocation already happened.
  let token = connection.accessToken;
  try {
    token = await freshAccessToken();
  } catch {
    /* best effort — fall back to the stored token */
  }
  store.clearConnection();

  try {
    const response = await fetch(STRAVA_DEAUTHORIZE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formEncode({ access_token: token }),
    });
    return { revoked: response.ok };
  } catch {
    return { revoked: false };
  }
}
