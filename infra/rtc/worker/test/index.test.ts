/**
 * The Worker entry (src/index.ts): routing, the upgrade rate limit, the kill
 * switch, what is (not) handed to the room object, and the cron.
 */
import worker, { clientTag, type Env, handleFetch, handleScheduled } from '../src/index';
import { subtle, vectorRoom } from './harness';

const R = vectorRoom();

function env(overrides: Partial<Env> = {}) {
  const forwarded: Request[] = [];
  const names: string[] = [];
  const budgetCalls: string[] = [];
  const e: Env = {
    RTC_ENABLED: '1',
    IP_TAG_KEY: 'k',
    ROOMS: {
      idFromName: (n: string) => {
        names.push(n);
        return n;
      },
      get: () => ({
        fetch: async (r: Request) => {
          forwarded.push(r);
          return new Response(null, { status: 200 });
        },
      }),
    },
    BUDGET: {
      idFromName: (n: string) => n,
      get: () => ({
        fetch: async (url: string) => {
          budgetCalls.push(url);
          return new Response(null, { status: 204 });
        },
      }),
    },
    ...overrides,
  };
  return { e, forwarded, names, budgetCalls };
}

const upgrade = (path: string, ip = '203.0.113.7', method = 'GET') =>
  new Request(`https://rtc.example.org${path}`, {
    method,
    headers: {
      Upgrade: 'websocket',
      'CF-Connecting-IP': ip,
      'User-Agent': 'okhttp',
      Cookie: 'c=1',
    },
  });

describe('routing', () => {
  it('forwards /v1/r/<roomId> to the room object named by the room id', async () => {
    const { e, forwarded, names } = env();
    const res = await handleFetch(upgrade(`/v1/r/${R.roomId}`), e, subtle);
    expect(res.status).toBe(200);
    expect(names).toEqual([R.roomId]);
    expect(forwarded[0]!.url).toBe(`https://room/v1/r/${R.roomId}`);
  });

  it.each([
    ['/'],
    ['/v1/r/'],
    ['/v1/r/short'],
    [`/v1/r/${R.roomId}/x`],
    [`/v2/r/${R.roomId}`],
    ['/v1/turn'],
    [`/v1/r/${R.roomId.slice(0, 21)}B`], // non-canonical base64url
  ])('404 for %s', async (path) => {
    const { e, forwarded } = env();
    expect((await handleFetch(upgrade(path), e, subtle)).status).toBe(404);
    expect(forwarded).toHaveLength(0);
  });

  it('404 for other methods, 426 without an upgrade', async () => {
    const { e } = env();
    expect(
      (await handleFetch(upgrade(`/v1/r/${R.roomId}`, '1.1.1.1', 'POST'), e, subtle)).status,
    ).toBe(404);
    expect((await handleFetch(new Request(`https://x/v1/r/${R.roomId}`), e, subtle)).status).toBe(
      426,
    );
  });
});

describe('R-META-5: the IP is a rate-limit key and an opaque tag, never forwarded', () => {
  it('hands the room only host + tag, no client header', async () => {
    const { e, forwarded } = env();
    await handleFetch(upgrade(`/v1/r/${R.roomId}`), e, subtle);
    const r = forwarded[0]!;
    const headers = Object.fromEntries(r.headers.entries());
    expect(Object.keys(headers).sort()).toEqual(['upgrade', 'x-rtc-host', 'x-rtc-tag']);
    expect(headers['x-rtc-host']).toBe('rtc.example.org');
    expect(headers['x-rtc-tag']).toBe(await clientTag(subtle, 'k', '203.0.113.7'));
    expect(JSON.stringify(headers)).not.toContain('203.0.113.7');
  });

  it('tags are stable per IP and key, distinct across IPs and keys', async () => {
    const a = await clientTag(subtle, 'k', '203.0.113.7');
    expect(a).toHaveLength(16);
    expect(await clientTag(subtle, 'k', '203.0.113.7')).toBe(a);
    expect(await clientTag(subtle, 'k', '203.0.113.8')).not.toBe(a);
    expect(await clientTag(subtle, 'k2', '203.0.113.7')).not.toBe(a);
  });
});

describe('R-RL-1: upgrades per IP', () => {
  it('429 when WS_LIMITER refuses, keyed by the IP', async () => {
    const keys: string[] = [];
    const { e, forwarded } = env({
      WS_LIMITER: {
        limit: async ({ key }) => {
          keys.push(key);
          return { success: false };
        },
      },
    });
    const res = await handleFetch(upgrade(`/v1/r/${R.roomId}`), e, subtle);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(keys).toEqual(['203.0.113.7']);
    expect(forwarded).toHaveLength(0);
  });

  it('a throwing limiter fails open', async () => {
    const { e } = env({
      WS_LIMITER: {
        limit: async () => {
          throw new Error('x');
        },
      },
    });
    expect((await handleFetch(upgrade(`/v1/r/${R.roomId}`), e, subtle)).status).toBe(200);
  });
});

describe('kill switch', () => {
  it('RTC_ENABLED = "0" refuses every room (503)', async () => {
    const { e, forwarded } = env({ RTC_ENABLED: '0' });
    const res = await handleFetch(upgrade(`/v1/r/${R.roomId}`), e, subtle);
    expect(res.status).toBe(503);
    expect(forwarded).toHaveLength(0);
  });
});

describe('cron', () => {
  it('refreshes the TURN usage reading in the budget object', async () => {
    const { e, budgetCalls } = env();
    await handleScheduled(e);
    expect(budgetCalls).toEqual(['https://budget/usage']);
    const waited: Promise<unknown>[] = [];
    worker.scheduled({}, e, { waitUntil: (p) => waited.push(p) });
    await Promise.all(waited);
    expect(budgetCalls).toHaveLength(2);
  });

  it('the default export routes fetch', async () => {
    const { e } = env();
    expect((await worker.fetch(new Request('https://rtc.example.org/'), e)).status).toBe(404);
  });
});
