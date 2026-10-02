/**
 * `POST /donors` — the app's opt-in "Add your name to the donors list" (#476).
 *
 *   POST /donors
 *   { "name": "Anne T.", "place": "Rimouski" | null,
 *     "platform": "ios" | "android", "transactionIds": ["2000000123…", …] }
 *   → 202 { "ok": true }        filed as pending
 *   → 400 { "error": "…" }      invalid
 *   → 413                        body too large
 *   → 429                        rate limited (per client IP)
 *
 * A valid submission is written to R2 as `donors/pending/<ts>-<rand>.json`.
 * Nothing is published from here: the owner checks the transaction ids
 * against the App Store / Play reports and adds the name to
 * `docs/support/costs.json` by hand. The IP is used only for the rate limit
 * and is never stored; no email, account or device id is accepted.
 *
 * Limits mirror `src/core/support/donors.ts` in the app (kept separate: the
 * Worker is its own project).
 */

export const NAME_MAX = 40;
export const PLACE_MAX = 60;
export const MAX_TRANSACTIONS = 20;
export const TRANSACTION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
export const MAX_BODY_BYTES = 4096;

export interface PendingDonor {
  name: string;
  place: string | null;
  platform: 'ios' | 'android';
  transactionIds: string[];
  receivedAt: string;
}

export interface DonorDeps {
  /** Store one pending submission. */
  put(key: string, json: string): Promise<void>;
  /** True when this client may submit now. */
  allow(clientKey: string): Promise<boolean>;
  now(): Date;
  random(): string;
}

export interface DonorRequest {
  method: string;
  /** CF-Connecting-IP (or a fallback); used for rate limiting only. */
  client: string;
  body: string;
}

export interface DonorResponse {
  status: number;
  body: Record<string, unknown>;
}

function clean(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Validate a submission body; returns the stored shape or an error message. */
export function parseDonor(raw: unknown, receivedAt: Date): PendingDonor | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return 'body must be an object';
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string') return 'name required';
  const name = clean(r.name);
  if (name === '' || name.length > NAME_MAX) return `name must be 1-${NAME_MAX} characters`;
  let place: string | null = null;
  if (r.place !== undefined && r.place !== null) {
    if (typeof r.place !== 'string') return 'place must be a string';
    const p = clean(r.place);
    if (p.length > PLACE_MAX) return `place must be at most ${PLACE_MAX} characters`;
    place = p === '' ? null : p;
  }
  if (r.platform !== 'ios' && r.platform !== 'android') return 'platform must be ios or android';
  const ids = r.transactionIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_TRANSACTIONS)
    return `transactionIds must list 1-${MAX_TRANSACTIONS} ids`;
  if (!ids.every((id): id is string => typeof id === 'string' && TRANSACTION_ID.test(id)))
    return 'invalid transaction id';
  // Anything else in the body (an email, a device id…) is dropped, never stored.
  return {
    name,
    place,
    platform: r.platform,
    transactionIds: [...new Set(ids)],
    receivedAt: receivedAt.toISOString(),
  };
}

export async function handleDonor(req: DonorRequest, deps: DonorDeps): Promise<DonorResponse> {
  if (req.method !== 'POST') return { status: 405, body: { error: 'method not allowed' } };
  if (new TextEncoder().encode(req.body).length > MAX_BODY_BYTES)
    return { status: 413, body: { error: 'body too large' } };
  if (!(await deps.allow(req.client))) return { status: 429, body: { error: 'try again later' } };
  let raw: unknown;
  try {
    raw = JSON.parse(req.body);
  } catch {
    return { status: 400, body: { error: 'invalid JSON' } };
  }
  const now = deps.now();
  const donor = parseDonor(raw, now);
  if (typeof donor === 'string') return { status: 400, body: { error: donor } };
  const key = `donors/pending/${now.getTime()}-${deps.random()}.json`;
  await deps.put(key, JSON.stringify(donor, null, 2));
  return { status: 202, body: { ok: true } };
}

/**
 * Best-effort per-isolate limiter, used when the `DONOR_LIMITER` rate-limit
 * binding is not configured: at most `limit` submissions per client per
 * `windowMs` in this isolate.
 */
export function memoryLimiter(limit = 3, windowMs = 60 * 60_000) {
  const hits = new Map<string, number[]>();
  return async (client: string, now = Date.now()): Promise<boolean> => {
    const recent = (hits.get(client) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      hits.set(client, recent);
      return false;
    }
    recent.push(now);
    hits.set(client, recent);
    if (hits.size > 5000) hits.clear();
    return true;
  };
}
