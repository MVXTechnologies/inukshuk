/**
 * The TURN budget object (src/budget.ts): kill switch, per-client and daily
 * caps, usage cron with fail-closed reading, TTL cap (R-TURN-1…4, R-RL-1).
 */
import { Budget, type BudgetEnv, USAGE_FRESH_MS, USAGE_MAX_AGE_MS } from '../src/budget';
import { BUDGET_ENV, fakeApi, strict, T0 } from './harness';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function make(env: Partial<BudgetEnv> = {}, api = fakeApi()) {
  const clock = { now: T0 };
  const touched: string[] = [];
  const budget = new Budget(
    strict({}, [], touched),
    { ...BUDGET_ENV, ...env },
    {
      now: () => clock.now,
      fetch: api.fetchFn,
    },
  );
  return { budget, api, clock, touched };
}

let spies: jest.SpyInstance[] = [];
beforeEach(() => {
  spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
    jest.spyOn(console, m).mockImplementation(() => undefined),
  );
});
afterEach(() => {
  for (const s of spies) expect(s).not.toHaveBeenCalled();
  for (const s of spies) s.mockRestore();
});

describe('R-TURN-4: kill switch and missing secrets', () => {
  it.each([['0'], [''], [undefined], ['true']])('TURN_ENABLED=%p mints nothing', async (v) => {
    const { budget, api } = make({ TURN_ENABLED: v });
    expect(await budget.mint('t')).toEqual({ ok: false, e: 'off' });
    expect(api.calls).toHaveLength(0);
  });

  it('is off without the TURN key or token', async () => {
    expect(await make({ TURN_KEY_ID: undefined }).budget.mint('t')).toEqual({
      ok: false,
      e: 'off',
    });
    expect(await make({ TURN_KEY_API_TOKEN: '' }).budget.mint('t')).toEqual({
      ok: false,
      e: 'off',
    });
  });
});

describe('minting', () => {
  it('mints with TTL ≤ 900 s whatever the config (R-TURN-2)', async () => {
    for (const ttl of ['172800', '901', 'nonsense']) {
      const { budget, api } = make({ TURN_TTL_S: ttl });
      const r = await budget.mint('t');
      expect(r).toMatchObject({ ok: true, ttl: 900, username: 'user1' });
      const mint = api.calls.find((c) => c.url.endsWith('generate-ice-servers'))!;
      expect(JSON.parse(mint.init!.body as string)).toEqual({ ttl: 900 });
      expect((mint.init!.headers as Record<string, string>).Authorization).toBe(
        'Bearer token-not-real',
      );
    }
    const { budget } = make({ TURN_TTL_S: '300' });
    expect(await budget.mint('t')).toMatchObject({ ttl: 300 });
  });

  it('answers busy (and still counts) when the TURN API fails', async () => {
    const api = fakeApi({ mintStatus: 500 });
    const { budget } = make({}, api);
    expect(await budget.mint('t')).toEqual({ ok: false, e: 'busy' });
    expect(budget.mintedToday).toBe(1);
  });

  it('serves the internal HTTP surface', async () => {
    const { budget } = make();
    const res = await budget.fetch(
      new Request('https://budget/mint', { method: 'POST', body: '{"tag":"x"}' }),
    );
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect((await budget.fetch(new Request('https://budget/mint'))).status).toBe(405);
    expect(
      (await budget.fetch(new Request('https://budget/nope', { method: 'POST', body: '{}' })))
        .status,
    ).toBe(404);
    const bad = await budget.fetch(
      new Request('https://budget/mint', { method: 'POST', body: 'not json' }),
    );
    expect(((await bad.json()) as { ok: boolean }).ok).toBe(true); // tag "unknown"
    expect(
      (await budget.fetch(new Request('https://budget/usage', { method: 'POST', body: '{}' })))
        .status,
    ).toBe(204);
  });
});

describe('R-RL-1: per-client hourly cap', () => {
  it('allows TURN_PER_IP_PER_HOUR per client tag, others unaffected, resets after an hour', async () => {
    const { budget, clock } = make({ TURN_PER_IP_PER_HOUR: '20' });
    for (let i = 0; i < 20; i++) {
      clock.now += 1000;
      expect((await budget.mint('abuser')).ok).toBe(true);
    }
    expect(await budget.mint('abuser')).toEqual({ ok: false, e: 'rate' });
    expect((await budget.mint('honest')).ok).toBe(true);
    clock.now += 3_600_000;
    expect((await budget.mint('abuser')).ok).toBe(true);
  });

  it('honours the per-minute TURN_LIMITER binding, fails open when it throws', async () => {
    const no = make({ TURN_LIMITER: { limit: async () => ({ success: false }) } });
    expect(await no.budget.mint('t')).toEqual({ ok: false, e: 'rate' });
    const broken = make({
      TURN_LIMITER: {
        limit: async () => {
          throw new Error('x');
        },
      },
    });
    expect((await broken.budget.mint('t')).ok).toBe(true);
  });

  it('stays bounded with many clients', async () => {
    const { budget, clock } = make({ TURN_DAILY_BUDGET: '5000' });
    for (let i = 0; i < 1500; i++) await budget.mint(`c${i}`);
    clock.now += 3_600_001;
    expect((await budget.mint('late')).ok).toBe(true);
    // Idle tags were forgotten (internal map pruned past 1000 entries).
    expect((budget as unknown as { perClient: Map<string, unknown> }).perClient.size).toBe(1);
  });
});

describe('CGNAT: a whole relayed team behind one carrier IP', () => {
  /** The per-minute TURN_LIMITER binding (5 per client per minute), simulated. */
  function perMinute(limit: number, clock: { now: number }) {
    const hits = new Map<string, number[]>();
    return {
      limit: async ({ key }: { key: string }) => {
        const recent = (hits.get(key) ?? []).filter((t) => clock.now - t < 60_000);
        recent.push(clock.now);
        hits.set(key, recent);
        return { success: recent.length <= limit };
      },
    };
  }

  /** The burst limit configured for TURN_LIMITER in wrangler.toml. */
  const BURST = Number(
    /name = "TURN_LIMITER"[\s\S]*?limit = (\d+)/.exec(
      readFileSync(join(__dirname, '..', 'wrangler.toml'), 'utf8'),
    )![1],
  );

  it('the configured burst is 15 per client per minute', () => {
    expect(BURST).toBe(15);
  });

  it('group restart: 12 phones on one IP ask in the same minute and all get credentials', async () => {
    const clock = { now: T0 };
    const api = fakeApi();
    const budget = new Budget(
      {},
      { ...BUDGET_ENV, TURN_PER_IP_PER_HOUR: undefined, TURN_LIMITER: perMinute(BURST, clock) },
      { now: () => clock.now, fetch: api.fetchFn },
    );
    const results = [];
    for (let p = 0; p < 12; p++) {
      clock.now = T0 + p * 1000; // all within one minute
      results.push(await budget.mint('carrier-ip'));
    }
    expect(results.every((r) => r.ok)).toBe(true);
    // The burst still bounds one client: the 16th in that minute is refused.
    for (let p = 12; p < 15; p++) expect((await budget.mint('carrier-ip')).ok).toBe(true);
    expect(await budget.mint('carrier-ip')).toEqual({ ok: false, e: 'rate' });
  });

  it('12 phones on one IP, relayed for an hour (first credential + renewal every 15 min), all served', async () => {
    const clock = { now: T0 };
    const api = fakeApi();
    const budget = new Budget(
      {},
      { ...BUDGET_ENV, TURN_PER_IP_PER_HOUR: undefined, TURN_LIMITER: perMinute(BURST, clock) },
      { now: () => clock.now, fetch: api.fetchFn },
    );
    const refused: string[] = [];
    // All phones start together (a refused phone would retry a minute later).
    const due = Array.from({ length: 12 }, () => T0);
    for (let t = T0; t < T0 + 3_600_000; t += 60_000) {
      clock.now = t;
      for (let p = 0; p < 12; p++) {
        if (due[p]! > t) continue;
        const r = await budget.mint('carrier-ip');
        if (r.ok) due[p] = t + 15 * 60_000;
        else {
          refused.push(`${p}@${(t - T0) / 60_000}:${r.e}`);
          due[p] = t + 60_000;
        }
      }
    }
    expect(refused).toEqual([]);
    expect(api.mints()).toBe(48); // 12 phones × 4 per hour
  });

  it('the default per-IP cap is 60 an hour', async () => {
    const { budget, clock } = make({ TURN_PER_IP_PER_HOUR: undefined });
    for (let i = 0; i < 60; i++) {
      clock.now += 1000;
      expect((await budget.mint('ip')).ok).toBe(true);
    }
    expect(await budget.mint('ip')).toEqual({ ok: false, e: 'rate' });
  });

  it('the daily budget still caps everyone together', async () => {
    const { budget, clock } = make({ TURN_PER_IP_PER_HOUR: undefined, TURN_DAILY_BUDGET: '50' });
    let ok = 0;
    for (let i = 0; i < 100; i++) {
      clock.now += 1000;
      if ((await budget.mint(`ip${i % 3}`)).ok) ok++;
    }
    expect(ok).toBe(50);
    expect(await budget.mint('fresh-ip')).toEqual({ ok: false, e: 'budget' });
  });
});

describe('R-TURN-3: global daily budget (exhaustion)', () => {
  it('stops at TURN_DAILY_BUDGET for everyone, resets at UTC midnight', async () => {
    const { budget, clock, api } = make({ TURN_DAILY_BUDGET: '10' });
    for (let i = 0; i < 10; i++) expect((await budget.mint(`c${i}`)).ok).toBe(true);
    expect(await budget.mint('c-new')).toEqual({ ok: false, e: 'budget' });
    expect(api.mints()).toBe(10);
    expect(budget.mintedToday).toBe(10);
    const midnight = Math.ceil(clock.now / 86_400_000) * 86_400_000;
    clock.now = midnight;
    expect(budget.mintedToday).toBe(0);
    expect((await budget.mint('c-new')).ok).toBe(true);
  });
});

describe('R-TURN-4: usage reading (cron) and fail-closed minting', () => {
  it('stops minting at 80 % of the monthly allowance', async () => {
    const api = fakeApi({ egressBytes: 799_999_999_999 });
    const { budget, clock } = make({}, api);
    expect((await budget.mint('t')).ok).toBe(true);
    api.state.egressBytes = 800_000_000_000;
    clock.now += USAGE_FRESH_MS;
    expect(await budget.mint('t')).toEqual({ ok: false, e: 'busy' });
  });

  it('re-reads usage at most every 10 minutes', async () => {
    const api = fakeApi();
    const { budget, clock } = make({}, api);
    for (let i = 0; i < 5; i++) await budget.mint('t');
    const usageCalls = () => api.calls.filter((c) => c.url.endsWith('/graphql')).length;
    expect(usageCalls()).toBe(1);
    clock.now += USAGE_FRESH_MS;
    await budget.mint('t');
    expect(usageCalls()).toBe(2);
  });

  it('the cron refresh flips minting off without waiting for a mint', async () => {
    const api = fakeApi();
    const { budget } = make({}, api);
    expect((await budget.mint('t')).ok).toBe(true);
    api.state.egressBytes = 900_000_000_000;
    await budget.refreshUsage();
    expect(await budget.mint('t')).toEqual({ ok: false, e: 'busy' });
  });

  it('fails closed with no reading (no analytics token, or API errors)', async () => {
    expect(await make({ CF_ANALYTICS_TOKEN: undefined }).budget.mint('t')).toEqual({
      ok: false,
      e: 'busy',
    });
    expect(await make({ CF_ACCOUNT_ID: 'not-an-account' }).budget.mint('t')).toEqual({
      ok: false,
      e: 'busy',
    });
    expect(await make({}, fakeApi({ usageOk: false })).budget.mint('t')).toEqual({
      ok: false,
      e: 'busy',
    });
  });

  it('keeps using a reading up to an hour old when refreshing fails, then fails closed', async () => {
    const api = fakeApi();
    const { budget, clock } = make({}, api);
    expect((await budget.mint('t')).ok).toBe(true);
    api.state.usageOk = false;
    clock.now += USAGE_MAX_AGE_MS - 1;
    expect((await budget.mint('t')).ok).toBe(true);
    clock.now += 1;
    expect(await budget.mint('t')).toEqual({ ok: false, e: 'busy' });
  });

  it('runs one usage query at a time', async () => {
    const api = fakeApi();
    const { budget } = make({}, api);
    await Promise.all([budget.refreshUsage(), budget.refreshUsage(), budget.mint('t')]);
    expect(api.calls.filter((c) => c.url.endsWith('/graphql'))).toHaveLength(1);
  });

  it('queries this calendar month of the configured account', async () => {
    const api = fakeApi();
    const { budget } = make({}, api);
    await budget.refreshUsage();
    const call = api.calls[0]!;
    expect(call.url).toBe('https://api.cloudflare.com/client/v4/graphql');
    const body = JSON.parse(call.init!.body as string) as { variables: Record<string, string> };
    expect(body.variables).toEqual({
      accountTag: '0123456789abcdef0123456789abcdef',
      dateFrom: '2026-10-01',
      dateTo: '2026-10-15',
    });
  });
});

describe('revoke', () => {
  it('revokes valid usernames only, at most 16, nothing without secrets', async () => {
    const api = fakeApi();
    const { budget } = make({}, api);
    await budget.revoke(['u1', '../x', 42, ...Array.from({ length: 20 }, (_, i) => `v${i}`)]);
    const urls = api.calls.map((c) => c.url);
    expect(urls[0]).toBe(
      'https://rtc.live.cloudflare.com/v1/turn/keys/key123/credentials/u1/revoke',
    );
    expect(urls.some((u) => u.includes('..'))).toBe(false);
    expect(urls).toHaveLength(14); // 16 entries looked at, 2 invalid
    const none = fakeApi();
    await make({ TURN_KEY_ID: undefined }, none).budget.revoke(['u1']);
    expect(none.calls).toHaveLength(0);
  });

  it('the internal route ignores a malformed body', async () => {
    const api = fakeApi();
    const { budget } = make({}, api);
    const res = await budget.fetch(
      new Request('https://budget/revoke', { method: 'POST', body: '{"usernames":"u1"}' }),
    );
    expect(res.status).toBe(204);
    expect(api.calls).toHaveLength(0);
  });
});

it('touches no storage (R-RLY-1)', async () => {
  const { budget, touched } = make();
  await budget.mint('t');
  await budget.refreshUsage();
  await budget.revoke(['user1']);
  expect(touched).toEqual([]);
});
