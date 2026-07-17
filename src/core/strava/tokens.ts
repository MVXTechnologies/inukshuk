/**
 * Pure token logic for the Strava connection: expiry math, total parsing of
 * Strava's token responses, and sanitization of the persisted document.
 *
 * Strava specifics that shape this module:
 *  - `expires_at` is reported in epoch SECONDS (not ms) — kept that way here so
 *    stored values match the API verbatim; the ms conversion happens only in
 *    {@link isTokenFresh}.
 *  - Strava ROTATES refresh tokens: every refresh response may carry a new
 *    `refresh_token`, and the old one stops working. Callers must always store
 *    the tokens returned by {@link parseTokenResponse}, never keep the old ones.
 */

/** OAuth tokens for the connected Strava athlete. `expiresAt` is epoch seconds. */
export interface StravaTokens {
  accessToken: string;
  refreshToken: string;
  /** Access-token expiry, epoch seconds (as Strava reports it). */
  expiresAt: number;
}

/** The persisted Strava connection: tokens plus who they belong to. */
export interface StravaConnection extends StravaTokens {
  /** Strava athlete id, when the token exchange included one. */
  athleteId: number | null;
  /** Display name shown in Settings ("Jane Doe"), possibly empty. */
  athleteName: string;
}

/**
 * Refresh this long before the reported expiry: an upload that starts with a
 * token about to lapse mid-flight would fail pointlessly.
 */
export const TOKEN_EXPIRY_SKEW_S = 300;

/** True when the access token is still usable at `nowMs` (with safety skew). */
export function isTokenFresh(
  expiresAtS: number,
  nowMs: number,
  skewS: number = TOKEN_EXPIRY_SKEW_S,
): boolean {
  return nowMs / 1000 < expiresAtS - skewS;
}

/** A successfully parsed token response: tokens plus the athlete, if present. */
export interface ParsedTokenResponse {
  tokens: StravaTokens;
  /** Present on the initial authorization-code exchange, absent on refreshes. */
  athlete: { id: number | null; name: string } | null;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;

const asString = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

const asFiniteNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * Totally parse a Strava `/oauth/token` response (exchange or refresh).
 * Returns null on anything malformed — never throws on junk.
 */
export function parseTokenResponse(json: unknown): ParsedTokenResponse | null {
  const body = asRecord(json);
  if (!body) return null;
  const accessToken = asString(body.access_token);
  const refreshToken = asString(body.refresh_token);
  const expiresAt = asFiniteNumber(body.expires_at);
  if (accessToken === null || refreshToken === null || expiresAt === null) return null;

  const athleteRecord = asRecord(body.athlete);
  let athlete: ParsedTokenResponse['athlete'] = null;
  if (athleteRecord) {
    const first = asString(athleteRecord.firstname) ?? '';
    const last = asString(athleteRecord.lastname) ?? '';
    athlete = {
      id: asFiniteNumber(athleteRecord.id),
      name: `${first} ${last}`.trim(),
    };
  }
  return { tokens: { accessToken, refreshToken, expiresAt }, athlete };
}

/** Current `strava.json` schema. */
export const STRAVA_SCHEMA_VERSION = 1;

/** Shape of the persisted `strava.json` document. */
export interface StravaDoc {
  schemaVersion: number;
  connection: StravaConnection | null;
}

/**
 * Totally sanitize a persisted `strava.json` read from disk. A torn or junk
 * file yields a disconnected state instead of crashing hydration.
 */
export function sanitizeStravaDoc(json: unknown): StravaConnection | null {
  const doc = asRecord(json);
  if (!doc) return null;
  const conn = asRecord(doc.connection);
  if (!conn) return null;
  const accessToken = asString(conn.accessToken);
  const refreshToken = asString(conn.refreshToken);
  const expiresAt = asFiniteNumber(conn.expiresAt);
  if (accessToken === null || refreshToken === null || expiresAt === null) return null;
  return {
    accessToken,
    refreshToken,
    expiresAt,
    athleteId: asFiniteNumber(conn.athleteId),
    athleteName: asString(conn.athleteName) ?? '',
  };
}
