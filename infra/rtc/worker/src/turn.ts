/**
 * Cloudflare Realtime TURN API: mint and revoke short-lived credentials, and
 * read this month's TURN egress (the usage cron, R-TURN-4).
 *
 * - Mint: `POST https://rtc.live.cloudflare.com/v1/turn/keys/{id}/credentials/generate-ice-servers`
 *   `{ttl}` → `{iceServers: [{urls}, {urls, username, credential}]}`.
 * - Revoke: `POST …/credentials/{username}/revoke` → 204.
 * - Usage: GraphQL `callsTurnUsageAdaptiveGroups { sum { egressBytes } }`
 *   over the calendar month (UTC), all keys of the account.
 *
 * Every answer is validated before it reaches a phone; anything unexpected is
 * a failure, and a failure never mints (fail closed).
 */

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

const API = 'https://rtc.live.cloudflare.com/v1/turn/keys/';
const ICE_URL = /^(stun|turn|turns):[A-Za-z0-9.:?=_-]{1,200}$/;
const CRED = /^[A-Za-z0-9+/=._:-]{1,512}$/;
/** Usernames we put in a revoke URL: path-safe characters only. */
const USERNAME = /^[A-Za-z0-9._:-]{1,256}$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,128}$/;

function validServer(v: unknown): IceServer | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const urls = typeof o.urls === 'string' ? [o.urls] : o.urls;
  if (!Array.isArray(urls) || urls.length === 0 || urls.length > 12) return undefined;
  if (!urls.every((u) => typeof u === 'string' && ICE_URL.test(u))) return undefined;
  const out: IceServer = { urls: urls as string[] };
  if (o.username !== undefined || o.credential !== undefined) {
    if (typeof o.username !== 'string' || !USERNAME.test(o.username)) return undefined;
    if (typeof o.credential !== 'string' || !CRED.test(o.credential)) return undefined;
    out.username = o.username;
    out.credential = o.credential;
  }
  return out;
}

/** The validated `iceServers` of a mint answer, with the credential's username. */
export function parseMintAnswer(
  body: unknown,
): { iceServers: IceServer[]; username: string } | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const raw = (body as Record<string, unknown>).iceServers;
  const list = Array.isArray(raw) ? raw : raw === undefined ? undefined : [raw];
  if (list === undefined || list.length === 0 || list.length > 4) return undefined;
  const servers: IceServer[] = [];
  for (const s of list) {
    const v = validServer(s);
    if (v === undefined) return undefined;
    servers.push(v);
  }
  const username = servers.find((s) => s.username !== undefined)?.username;
  return username === undefined ? undefined : { iceServers: servers, username };
}

export async function mintCredential(
  fetchFn: Fetch,
  keyId: string,
  token: string,
  ttlS: number,
): Promise<{ iceServers: IceServer[]; username: string } | undefined> {
  if (!KEY_ID.test(keyId)) return undefined;
  try {
    const res = await fetchFn(`${API}${keyId}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: ttlS }),
    });
    if (res.status !== 200 && res.status !== 201) return undefined;
    return parseMintAnswer(await res.json());
  } catch {
    return undefined;
  }
}

export async function revokeCredential(
  fetchFn: Fetch,
  keyId: string,
  token: string,
  username: string,
): Promise<boolean> {
  if (!KEY_ID.test(keyId) || !USERNAME.test(username)) return false;
  try {
    const res = await fetchFn(`${API}${keyId}/credentials/${encodeURIComponent(username)}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
export const USAGE_QUERY = `query TurnEgress($accountTag: string!, $dateFrom: Date!, $dateTo: Date!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      callsTurnUsageAdaptiveGroups(limit: 10000, filter: { date_geq: $dateFrom, date_leq: $dateTo }) {
        sum { egressBytes }
      }
    }
  }
}`;

/** First and current day (YYYY-MM-DD, UTC) of the month containing `nowMs`. */
export function monthRange(nowMs: number): { dateFrom: string; dateTo: string } {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  return { dateFrom: today.slice(0, 8) + '01', dateTo: today };
}

/** Total egress bytes in a GraphQL answer, or undefined when it is not one. */
export function parseUsageAnswer(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const o = body as { errors?: unknown; data?: unknown };
  if (Array.isArray(o.errors) && o.errors.length > 0) return undefined;
  const accounts = (o.data as { viewer?: { accounts?: unknown } } | undefined)?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1) return undefined;
  const groups = (accounts[0] as { callsTurnUsageAdaptiveGroups?: unknown })
    .callsTurnUsageAdaptiveGroups;
  if (!Array.isArray(groups)) return undefined;
  let total = 0;
  for (const g of groups) {
    const bytes = (g as { sum?: { egressBytes?: unknown } } | null)?.sum?.egressBytes;
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return undefined;
    total += bytes;
  }
  return total;
}

export async function fetchMonthlyEgress(
  fetchFn: Fetch,
  accountTag: string,
  token: string,
  nowMs: number,
): Promise<number | undefined> {
  if (!/^[a-f0-9]{32}$/.test(accountTag)) return undefined;
  try {
    const res = await fetchFn(GRAPHQL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: USAGE_QUERY,
        variables: { accountTag, ...monthRange(nowMs) },
      }),
    });
    if (res.status !== 200) return undefined;
    return parseUsageAnswer(await res.json());
  } catch {
    return undefined;
  }
}
