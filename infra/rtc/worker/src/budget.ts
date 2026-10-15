import { HOUR_MS, recent, TURN_MAX_TTL_S } from './limits';
import { positiveInt } from './protocol';
import {
  fetchMonthlyEgress,
  type Fetch,
  type IceServer,
  mintCredential,
  revokeCredential,
} from './turn';

/**
 * The TURN budget: one singleton Durable Object (`BUDGET`, name "budget")
 * that every TURN credential goes through (R-TURN-1…4, R-RL-1).
 *
 * In order, a mint is refused when:
 * 1. the kill switch `TURN_ENABLED` is not "1", or the TURN secrets are unset (`off`);
 * 2. this client already had `TURN_PER_IP_PER_HOUR` credentials in the last
 *    hour, or the per-minute `TURN_LIMITER` binding says no (`rate`);
 * 3. `TURN_DAILY_BUDGET` credentials were minted this UTC day (`budget`);
 * 4. this month's TURN egress is at `TURN_USAGE_OFF_PERCENT` of the free
 *    allowance, or there is no reading younger than an hour (`busy`; fail closed).
 *
 * Everything lives in memory (R-RLY-1). When the object is evicted the daily
 * count restarts, but eviction only happens after it has been idle (no mint
 * for a while), so a client pacing mints to evade the count is held to about
 * one mint per idle period anyway, and the usage reading (Cloudflare's own
 * byte count) is re-read before the first mint after a restart. Clients are
 * known only by an opaque tag (an HMAC of the IP under a secret key, made by
 * the Worker); the IP itself never reaches this object.
 */

export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface BudgetEnv {
  TURN_ENABLED?: string;
  TURN_TTL_S?: string;
  TURN_PER_IP_PER_HOUR?: string;
  TURN_DAILY_BUDGET?: string;
  TURN_MONTHLY_ALLOWANCE_GB?: string;
  TURN_USAGE_OFF_PERCENT?: string;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_ANALYTICS_TOKEN?: string;
  TURN_LIMITER?: RateLimit;
}

export interface BudgetDeps {
  now(): number;
  fetch: Fetch;
}

export type MintRefusal = 'off' | 'rate' | 'budget' | 'busy';
export type MintResult =
  | { ok: true; iceServers: IceServer[]; ttl: number; username: string }
  | { ok: false; e: MintRefusal };

/** A usage reading is reused this long before it is refreshed… */
export const USAGE_FRESH_MS = 10 * 60_000;
/** …and trusted at most this long when refreshing fails. */
export const USAGE_MAX_AGE_MS = HOUR_MS;
const GB = 1_000_000_000;

function utcDay(ms: number): number {
  return Math.floor(ms / 86_400_000);
}

export function defaultBudgetDeps(): BudgetDeps {
  return { now: () => Date.now(), fetch: (input, init) => fetch(input, init) };
}

export class Budget {
  private day = -1;
  private minted = 0;
  private readonly perClient = new Map<string, number[]>();
  private usage: { at: number; egressBytes: number } | undefined;
  private refreshing: Promise<void> | undefined;

  constructor(
    _state: unknown,
    private readonly env: BudgetEnv,
    private readonly deps: BudgetDeps = defaultBudgetDeps(),
  ) {}

  /** Internal HTTP surface, reachable only through the namespace binding. */
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = undefined;
    }
    const o = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    switch (path) {
      case '/mint':
        return Response.json(await this.mint(typeof o.tag === 'string' ? o.tag : 'unknown'));
      case '/revoke':
        await this.revoke(Array.isArray(o.usernames) ? o.usernames : []);
        return new Response(null, { status: 204 });
      case '/usage':
        await this.refreshUsage();
        return new Response(null, { status: 204 });
      default:
        return new Response(null, { status: 404 });
    }
  }

  /** Credentials minted this UTC day (tests and the README's dry run). */
  get mintedToday(): number {
    return this.day === utcDay(this.deps.now()) ? this.minted : 0;
  }

  async mint(clientTag: string): Promise<MintResult> {
    const env = this.env;
    const now = this.deps.now();
    if (env.TURN_ENABLED !== '1' || !env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
      return { ok: false, e: 'off' };
    }
    const today = utcDay(now);
    if (today !== this.day) {
      this.day = today;
      this.minted = 0;
    }
    this.forgetIdleClients(now);
    const times = recent(this.perClient.get(clientTag) ?? [], now, HOUR_MS);
    if (times.length >= positiveInt(env.TURN_PER_IP_PER_HOUR, 20)) return { ok: false, e: 'rate' };
    if (env.TURN_LIMITER !== undefined) {
      let allowed = true;
      try {
        allowed = (await env.TURN_LIMITER.limit({ key: clientTag })).success;
      } catch {
        allowed = true; // a broken binding falls back to the hourly cap above
      }
      if (!allowed) return { ok: false, e: 'rate' };
    }
    if (this.minted >= positiveInt(env.TURN_DAILY_BUDGET, 2000)) return { ok: false, e: 'budget' };
    if (!(await this.usageAllowsMinting(now))) return { ok: false, e: 'busy' };

    // Charge before calling out: a failed or slow call still counts.
    this.minted++;
    times.push(now);
    this.perClient.set(clientTag, times);
    const ttl = Math.min(positiveInt(env.TURN_TTL_S, TURN_MAX_TTL_S), TURN_MAX_TTL_S);
    const minted = await mintCredential(
      this.deps.fetch,
      env.TURN_KEY_ID,
      env.TURN_KEY_API_TOKEN,
      ttl,
    );
    if (minted === undefined) return { ok: false, e: 'busy' };
    return { ok: true, iceServers: minted.iceServers, ttl, username: minted.username };
  }

  async revoke(usernames: readonly unknown[]): Promise<void> {
    const { TURN_KEY_ID: keyId, TURN_KEY_API_TOKEN: token } = this.env;
    if (!keyId || !token) return;
    for (const u of usernames.slice(0, 16)) {
      if (typeof u === 'string') await revokeCredential(this.deps.fetch, keyId, token, u);
    }
  }

  /** Re-read this month's TURN egress (the cron calls this every 10 minutes). */
  async refreshUsage(): Promise<void> {
    if (this.refreshing !== undefined) return this.refreshing;
    this.refreshing = (async () => {
      const { CF_ACCOUNT_ID: account, CF_ANALYTICS_TOKEN: token } = this.env;
      if (!account || !token) return;
      const now = this.deps.now();
      const bytes = await fetchMonthlyEgress(this.deps.fetch, account, token, now);
      if (bytes !== undefined) this.usage = { at: now, egressBytes: bytes };
    })();
    try {
      await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }

  private async usageAllowsMinting(now: number): Promise<boolean> {
    if (this.usage === undefined || now - this.usage.at >= USAGE_FRESH_MS) {
      await this.refreshUsage();
    }
    const u = this.usage;
    if (u === undefined || now - u.at >= USAGE_MAX_AGE_MS) return false;
    const allowance = positiveInt(this.env.TURN_MONTHLY_ALLOWANCE_GB, 1000) * GB;
    const percent = Math.min(positiveInt(this.env.TURN_USAGE_OFF_PERCENT, 80), 100);
    return u.egressBytes < (allowance * percent) / 100;
  }

  private forgetIdleClients(now: number): void {
    if (this.perClient.size < 1000) return;
    for (const [tag, times] of this.perClient) {
      if (recent(times, now, HOUR_MS).length === 0) this.perClient.delete(tag);
    }
  }
}
