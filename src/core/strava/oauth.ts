/**
 * Pure OAuth plumbing for the Strava connection: URL/body building and total
 * parsing of the authorization redirect. No fetch, no platform APIs — the
 * network half lives in `src/lib/strava.ts`.
 *
 * Strava has NO PKCE: the authorization-code exchange and every refresh need
 * the client secret, and the June-2026 API agreement forbids shipping it in a
 * binary. So both go through our token proxy (the tile Worker, which holds the
 * secret — see infra/tiles/README.md § Strava); the app only knows the public
 * client id. The mobile authorize endpoint is used so the Strava app can
 * service the request when installed.
 */

/** Strava's mobile-optimized authorize endpoint (app-links into the Strava app). */
export const STRAVA_AUTHORIZE_URL = 'https://www.strava.com/oauth/mobile/authorize';
export const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
export const STRAVA_DEAUTHORIZE_URL = 'https://www.strava.com/oauth/deauthorize';
export const STRAVA_UPLOADS_URL = 'https://www.strava.com/api/v3/uploads';

/** Uploading a finished trail as a Strava activity. */
export const STRAVA_SCOPE = 'activity:write';
/** Importing the athlete's activities, private ones included (#432). */
export const STRAVA_READ_SCOPE = 'activity:read_all';
/** What the consent screen asks for; the athlete may untick either. */
export const STRAVA_REQUESTED_SCOPES = [STRAVA_SCOPE, STRAVA_READ_SCOPE] as const;

/** Token-proxy paths, relative to the tile host (see infra/tiles/worker). */
export const STRAVA_PROXY_TOKEN_PATH = '/strava/token';
export const STRAVA_PROXY_REFRESH_PATH = '/strava/refresh';

/**
 * The redirect Strava sends the browser back to after authorization.
 *
 * The `localhost` host is deliberate: Strava's API-app settings validate the
 * redirect's DOMAIN against the "Authorization Callback Domain" field, and for
 * custom-scheme mobile redirects their guidance is `appscheme://localhost/...`
 * with the callback domain set to `localhost`. The scheme (`inukshuk`) routes
 * the browser back into the app; `app/+native-intent.tsx` intercepts the path.
 */
export const STRAVA_REDIRECT_URI = 'inukshuk://localhost/strava-auth';

/** Marker used to recognize the redirect among incoming deep links. */
export const STRAVA_REDIRECT_PATH = 'strava-auth';

/** True when an incoming deep-link URL is the Strava OAuth redirect. */
export function isStravaAuthRedirect(url: string): boolean {
  return url.split('?')[0]?.includes(STRAVA_REDIRECT_PATH) ?? false;
}

/** application/x-www-form-urlencoded encoding (RN lacks a reliable URLSearchParams). */
export function formEncode(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

export function buildAuthorizeUrl(options: {
  clientId: string;
  redirectUri?: string;
  state: string;
}): string {
  const query = formEncode({
    client_id: options.clientId,
    redirect_uri: options.redirectUri ?? STRAVA_REDIRECT_URI,
    response_type: 'code',
    approval_prompt: 'auto',
    scope: STRAVA_REQUESTED_SCOPES.join(','),
    state: options.state,
  });
  return `${STRAVA_AUTHORIZE_URL}?${query}`;
}

/** JSON body for the proxy's code exchange; the proxy adds id + secret. */
export function buildTokenExchangeBody(code: string): string {
  return JSON.stringify({ code });
}

/** JSON body for the proxy's refresh; the proxy adds id + secret. */
export function buildTokenRefreshBody(refreshToken: string): string {
  return JSON.stringify({ refresh_token: refreshToken });
}

/**
 * Parse the query params out of a redirect URL by hand: React Native's URL /
 * URLSearchParams polyfills are unreliable, and this must also survive junk.
 * Malformed percent-escapes keep their raw text rather than throwing.
 */
export function parseRedirectParams(url: string): Record<string, string> {
  const query = url.split('?')[1];
  if (!query) return {};
  const params: Record<string, string> = {};
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = safeDecode(pair.slice(0, eq));
    params[key] = safeDecode(pair.slice(eq + 1));
  }
  return params;
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
}

/** Outcome of interpreting the authorization redirect. */
export type AuthRedirectOutcome =
  | { ok: true; code: string; scopes: string[] }
  | { ok: false; reason: 'denied' | 'state-mismatch' | 'missing-scope' | 'malformed' };

/**
 * Interpret the Strava redirect: reject denials, a state that doesn't match
 * ours (a spoofed/stale redirect), and grants with NEITHER activity scope (the
 * consent screen lets the athlete untick scopes — a connection that can
 * neither upload nor import would be a lie in Settings). A partial grant is
 * fine: `scopes` says which features the connection can drive. A redirect
 * without the scope param is taken as the full request (older behaviour).
 */
export function authRedirectOutcome(url: string, expectedState: string): AuthRedirectOutcome {
  const params = parseRedirectParams(url);
  if (params.error !== undefined) return { ok: false, reason: 'denied' };
  if (params.state !== expectedState) return { ok: false, reason: 'state-mismatch' };
  const code = params.code;
  if (code === undefined || code === '') return { ok: false, reason: 'malformed' };
  const scope = params.scope;
  const granted =
    scope === undefined
      ? [...STRAVA_REQUESTED_SCOPES]
      : STRAVA_REQUESTED_SCOPES.filter((s) => scope.split(',').includes(s));
  if (granted.length === 0) return { ok: false, reason: 'missing-scope' };
  return { ok: true, code, scopes: granted };
}
