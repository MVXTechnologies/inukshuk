import {
  conditionalHeaders,
  PoliteClient,
  validatorsOf,
  type HttpRequestInit,
  type HttpResponse,
} from './politeClient';

const UA = 'InukshukCatalogBot/1.0 (+https://inukshuk.mvxtechnologies.com)';

function response(status: number, body = '', headers: Record<string, string> = {}): HttpResponse {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    text: () => Promise.resolve(body),
  };
}

interface Sent {
  url: string;
  init: HttpRequestInit;
  at: number;
}

/**
 * A fake network and clock: `routes` answers by URL (a function may throw to
 * simulate a network error); time only moves when the client sleeps.
 */
function harness(
  routes: Record<string, HttpResponse | (() => HttpResponse)>,
  options: { minIntervalMs?: number } = {},
) {
  let now = 1_000_000;
  const sent: Sent[] = [];
  const sleeps: number[] = [];
  const client = new PoliteClient({
    userAgent: UA,
    productToken: 'InukshukCatalogBot',
    minIntervalMs: options.minIntervalMs ?? 1000,
    fetch: (url, init) => {
      sent.push({ url, init, at: now });
      const route = routes[url];
      if (route === undefined) return Promise.resolve(response(404));
      try {
        return Promise.resolve(typeof route === 'function' ? route() : route);
      } catch (err) {
        return Promise.reject(err);
      }
    },
    sleep: (ms) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
    now: () => now,
  });
  return { client, sent, sleeps };
}

const ROBOTS = 'https://cartespleinair.org/robots.txt';
const SITE_ROBOTS = response(200, 'User-agent: *\nAllow: /\nDisallow: /api\n');

describe('PoliteClient', () => {
  it('identifies itself on every request, robots.txt included', async () => {
    const { client, sent } = harness({
      [ROBOTS]: SITE_ROBOTS,
      'https://cartespleinair.org/cartes': response(200, 'ok'),
    });
    const result = await client.request('https://cartespleinair.org/cartes');
    expect(result.kind).toBe('response');
    expect(sent.map((s) => s.url)).toEqual([ROBOTS, 'https://cartespleinair.org/cartes']);
    for (const s of sent) expect(s.init.headers['User-Agent']).toBe(UA);
  });

  it('reads robots.txt once per origin and never fetches a disallowed path', async () => {
    const { client, sent } = harness({ [ROBOTS]: SITE_ROBOTS });
    expect(await client.request('https://cartespleinair.org/api/explore/rivers')).toEqual({
      kind: 'disallowed',
    });
    expect(await client.request('https://cartespleinair.org/api/x?y=1')).toEqual({
      kind: 'disallowed',
    });
    expect(sent.map((s) => s.url)).toEqual([ROBOTS]);
  });

  it('treats an unreachable robots.txt as disallow-all, a 4xx as allow-all', async () => {
    const down = harness({ [ROBOTS]: response(503) });
    expect((await down.client.request('https://cartespleinair.org/cartes')).kind).toBe(
      'disallowed',
    );
    const s3 = harness({
      'https://assets.cartespleinair.org/robots.txt': response(403),
      'https://assets.cartespleinair.org/maps/a.pdf': response(200),
    });
    expect((await s3.client.request('https://assets.cartespleinair.org/maps/a.pdf')).kind).toBe(
      'response',
    );
  });

  it('keeps at least the minimum interval between two requests to one host', async () => {
    const { client, sent } = harness({
      [ROBOTS]: SITE_ROBOTS,
      'https://cartespleinair.org/a': response(200),
      'https://cartespleinair.org/b': response(200),
      'https://geogratis.gc.ca/robots.txt': response(404),
      'https://geogratis.gc.ca/x': response(200),
    });
    await client.request('https://cartespleinair.org/a');
    await client.request('https://geogratis.gc.ca/x');
    await client.request('https://cartespleinair.org/b');
    const site = sent.filter((s) => s.url.startsWith('https://cartespleinair.org'));
    for (let i = 1; i < site.length; i++) {
      expect((site[i]?.at ?? 0) - (site[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(1000);
    }
    // Another host is not held back by this one.
    const geo = sent.filter((s) => s.url.startsWith('https://geogratis.gc.ca'));
    expect(geo[0]?.at).toBe(site[1]?.at);
    expect(client.requestCounts()).toEqual({ 'cartespleinair.org': 3, 'geogratis.gc.ca': 2 });
  });

  it('honours a Crawl-delay longer than its own interval', async () => {
    const { client, sent } = harness({
      [ROBOTS]: response(200, 'User-agent: *\nCrawl-delay: 5\n'),
      'https://cartespleinair.org/a': response(200),
      'https://cartespleinair.org/b': response(200),
    });
    await client.request('https://cartespleinair.org/a');
    await client.request('https://cartespleinair.org/b');
    expect((sent[2]?.at ?? 0) - (sent[1]?.at ?? 0)).toBe(5000);
  });

  it('sends the validators of a previous answer, and a 304 is an answer', async () => {
    const { client, sent } = harness({
      [ROBOTS]: SITE_ROBOTS,
      'https://cartespleinair.org/cartes': response(304),
    });
    const result = await client.request('https://cartespleinair.org/cartes', {
      validators: { etag: '"abc"', lastModified: 'Mon, 25 May 2026 16:59:43 GMT' },
    });
    expect(result.kind === 'response' && result.response.status).toBe(304);
    expect(sent[1]?.init.headers).toMatchObject({
      'If-None-Match': '"abc"',
      'If-Modified-Since': 'Mon, 25 May 2026 16:59:43 GMT',
    });
  });

  it('passes method, redirect mode and headers through, but never lets a caller change the UA', async () => {
    const { client, sent } = harness({
      [ROBOTS]: SITE_ROBOTS,
      'https://cartespleinair.org/cartes/x': response(302, '', { Location: '/y.pdf' }),
    });
    await client.request('https://cartespleinair.org/cartes/x', {
      method: 'HEAD',
      redirect: 'manual',
      headers: { 'User-Agent': 'curl', 'Accept-Encoding': 'identity' },
    });
    expect(sent[1]?.init).toEqual({
      method: 'HEAD',
      redirect: 'manual',
      headers: { 'User-Agent': UA, 'Accept-Encoding': 'identity' },
    });
  });

  describe('redirects (2.5.2 review: never left to the fetch)', () => {
    const CDN_ROBOTS = 'https://cdn.example/robots.txt';
    const PAGE = 'https://cartespleinair.org/cartes/x';

    it('follows a Location itself: the new host’s robots.txt is read and obeyed', async () => {
      const { client, sent } = harness({
        [ROBOTS]: SITE_ROBOTS,
        [PAGE]: response(302, '', { Location: 'https://cdn.example/private/x.pdf' }),
        [CDN_ROBOTS]: response(200, 'User-agent: *\nDisallow: /private\n'),
      });
      expect(await client.request(PAGE, { method: 'HEAD' })).toEqual({ kind: 'disallowed' });
      // The disallowed file was never asked for, and the fetch never followed anything.
      expect(sent.map((x) => x.url)).toEqual([ROBOTS, PAGE, CDN_ROBOTS]);
      for (const x of sent) expect(x.init.redirect).toBe('manual');
    });

    it('a hop to the same host waits its turn; the answer names the final URL', async () => {
      const { client, sent } = harness({
        [ROBOTS]: SITE_ROBOTS,
        [PAGE]: response(301, '', { Location: '/cartes/y' }),
        'https://cartespleinair.org/cartes/y': response(200, 'ok'),
      });
      const result = await client.request(PAGE, { validators: { etag: '"v1"' } });
      expect(result.kind === 'response' && result.url).toBe('https://cartespleinair.org/cartes/y');
      expect(sent.map((x) => x.at - sent[0]!.at)).toEqual([0, 1000, 2000]);
      // The validators were the first URL's: not sent to the next.
      expect(sent[1]?.init.headers['If-None-Match']).toBe('"v1"');
      expect(sent[2]?.init.headers['If-None-Match']).toBeUndefined();
      expect(client.requestCounts()).toEqual({ 'cartespleinair.org': 3 });
    });

    it('stops after five hops, refuses a non-http Location, and keeps a 3xx under manual', async () => {
      const loop: Record<string, HttpResponse> = { [ROBOTS]: SITE_ROBOTS };
      for (let i = 0; i < 10; i++) {
        loop[`https://cartespleinair.org/l${i}`] = response(302, '', { Location: `/l${i + 1}` });
      }
      const looping = harness(loop);
      const r = await looping.client.request('https://cartespleinair.org/l0');
      expect(r.kind).toBe('failed');
      expect(looping.sent).toHaveLength(1 + 6);

      const odd = harness({
        [ROBOTS]: SITE_ROBOTS,
        [PAGE]: response(302, '', { Location: 'file:///etc/passwd' }),
      });
      expect((await odd.client.request(PAGE)).kind).toBe('failed');
      expect(odd.sent).toHaveLength(2);

      const manual = harness({
        [ROBOTS]: SITE_ROBOTS,
        [PAGE]: response(302, '', { Location: '/cartes/y' }),
      });
      const m = await manual.client.request(PAGE, { redirect: 'manual' });
      expect(m.kind === 'response' && m.response.status).toBe(302);
      expect(manual.sent).toHaveLength(2);
    });

    it('follows a redirected robots.txt (RFC 9309) instead of reading it as disallow-all', async () => {
      const { client, sent } = harness({
        [ROBOTS]: response(301, '', { Location: 'https://www.cartespleinair.org/robots.txt' }),
        'https://www.cartespleinair.org/robots.txt': SITE_ROBOTS,
        'https://cartespleinair.org/cartes': response(200, 'ok'),
      });
      expect((await client.request('https://cartespleinair.org/cartes')).kind).toBe('response');
      expect(sent.map((x) => x.url)).toEqual([
        ROBOTS,
        'https://www.cartespleinair.org/robots.txt',
        'https://cartespleinair.org/cartes',
      ]);
    });
  });

  it('retries a transient failure a bounded number of times, with backoff', async () => {
    let calls = 0;
    const { client, sent, sleeps } = harness({
      [ROBOTS]: SITE_ROBOTS,
      'https://cartespleinair.org/flaky': () => {
        calls += 1;
        if (calls === 1) throw new Error('ECONNRESET');
        return calls === 2 ? response(502) : response(200);
      },
      'https://cartespleinair.org/down': response(500),
    });
    expect((await client.request('https://cartespleinair.org/flaky')).kind).toBe('response');
    expect(sleeps.filter((ms) => ms === 2000 || ms === 8000)).toEqual([2000, 8000]);
    expect(await client.request('https://cartespleinair.org/down')).toEqual({
      kind: 'failed',
      reason: 'HTTP 500',
    });
    expect(sent.filter((s) => s.url.endsWith('/down'))).toHaveLength(3);
  });

  it('waits as long as Retry-After asks, and gives up on an unreasonable one', async () => {
    let calls = 0;
    const { client, sleeps } = harness({
      [ROBOTS]: SITE_ROBOTS,
      'https://cartespleinair.org/busy': () => {
        calls += 1;
        return calls === 1 ? response(429, '', { 'Retry-After': '7' }) : response(200);
      },
      'https://cartespleinair.org/later': response(503, '', { 'Retry-After': '3600' }),
    });
    expect((await client.request('https://cartespleinair.org/busy')).kind).toBe('response');
    expect(sleeps).toContain(7000);
    expect(await client.request('https://cartespleinair.org/later')).toEqual({
      kind: 'failed',
      reason: 'HTTP 503',
    });
  });
});

describe('validators', () => {
  it('reads ETag and Last-Modified, and turns them into conditional headers', () => {
    const v = validatorsOf(response(200, '', { ETag: '"x"', 'Last-Modified': 'Mon' }));
    expect(v).toEqual({ etag: '"x"', lastModified: 'Mon' });
    expect(validatorsOf(response(200))).toEqual({});
    expect(conditionalHeaders(undefined)).toEqual({});
    expect(conditionalHeaders({ etag: '"x"' })).toEqual({ 'If-None-Match': '"x"' });
  });
});
