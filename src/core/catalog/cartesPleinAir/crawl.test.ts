import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { crawlCartesPleinAir, LISTING_URL, type CrawlInput } from './crawl';
import { PoliteClient, type HttpRequestInit, type HttpResponse } from './politeClient';

/**
 * The crawler end to end against a fake network, through the real polite
 * client: what it asks for, in what order, how often — and what it never asks
 * for (a PDF body, the robots-disallowed API).
 */

const LISTING = readFileSync(join(__dirname, 'fixtures', 'listing.html'), 'utf8');
const UA = 'InukshukCatalogBot/1.0 (+https://inukshuk.mvxtechnologies.com)';

const SLUG_A = 'riviere-exemple-auteure-test-2023';
const SLUG_B = 'circuit-test-club-exemple-1998';
const PAGE_A = `https://cartespleinair.org/cartes/${SLUG_A}`;
const PAGE_B = `https://cartespleinair.org/cartes/${SLUG_B}`;
const FILE_A = `https://assets.cartespleinair.org/maps/${SLUG_A}-e06f583d13bd.pdf`;
const FILE_A2 = `https://assets.cartespleinair.org/maps/${SLUG_A}-ffffffffffff.pdf`;
const FILE_B = `https://assets.cartespleinair.org/maps/${SLUG_B}-0123456789ab.pdf`;
const ID_A = 'cpa-11111111-1111-4111-8111-111111111111';
const ID_B = 'cpa-22222222-2222-4222-8222-222222222222';

function res(status: number, body = '', headers: Record<string, string> = {}): HttpResponse {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (n) => lower[n.toLowerCase()] ?? null },
    text: () => Promise.resolve(body),
  };
}

const redirect = (to: string) => res(302, '', { Location: to });
const pdf = (etag: string, size: number) =>
  res(200, '', {
    'Content-Type': 'application/pdf',
    'Content-Length': String(size),
    ETag: `"${etag}"`,
    'Last-Modified': 'Mon, 25 May 2026 16:59:43 GMT',
  });
const geonames = (items: unknown[]) => res(200, JSON.stringify({ items }));

type Route = HttpResponse | ((init: HttpRequestInit) => HttpResponse);

function baseRoutes(): Record<string, Route> {
  return {
    'https://cartespleinair.org/robots.txt': res(
      200,
      'User-Agent: *\nAllow: /\nDisallow: /api\nDisallow: /admin\n',
    ),
    'https://assets.cartespleinair.org/robots.txt': res(403),
    'https://geogratis.gc.ca/robots.txt': res(200, 'User-agent: *\nDisallow: /api/beta/\n'),
    [LISTING_URL]: res(200, LISTING),
    [PAGE_A]: redirect(FILE_A),
    [PAGE_B]: redirect(FILE_B),
    [FILE_A]: pdf('etag-a', 2156252),
    [FILE_A2]: pdf('etag-a2', 2200000),
    [FILE_B]: pdf('etag-b', 900000),
  };
}

function geoRoute(name: string): string {
  return `https://geogratis.gc.ca/services/geoname/en/geonames.json?q=${encodeURIComponent(name)}`;
}

function harness(routes: Record<string, Route>) {
  let now = 0;
  const sent: { url: string; init: HttpRequestInit }[] = [];
  const client = new PoliteClient({
    userAgent: UA,
    productToken: 'InukshukCatalogBot',
    minIntervalMs: 1100,
    fetch: (url, init) => {
      sent.push({ url, init });
      const exact = routes[url];
      const geo = Object.entries(routes).find(
        ([key]) => key.startsWith('https://geogratis.gc.ca/services') && url.startsWith(key + '&'),
      )?.[1];
      const route = exact ?? geo;
      if (route === undefined) {
        return Promise.resolve(
          url.startsWith('https://geogratis.gc.ca/services') ? geonames([]) : res(404),
        );
      }
      return Promise.resolve(typeof route === 'function' ? route(init) : route);
    },
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    now: () => now,
  });
  return { client, sent, elapsed: () => now };
}

const desert = {
  id: 'X',
  name: 'Rivière Exemple',
  feature: { id: 'EX1' },
  status: { code: 'official' },
  concise: { code: 'RIV' },
  latitude: 46.4,
  longitude: -76.0,
  bbox: [-76.2, 46.3, -75.8, 46.7],
};

function input(over: Partial<CrawlInput> & Pick<CrawlInput, 'client'>): CrawlInput {
  return { previous: [], gazetteer: {}, today: '2026-10-14', ...over };
}

describe('crawlCartesPleinAir', () => {
  it('builds the catalog from the listing, one HEAD per page and per new file', async () => {
    const routes = baseRoutes();
    routes[geoRoute('Exemple')] = geonames([desert]);
    const { client, sent, elapsed } = harness(routes);
    const out = await crawlCartesPleinAir(input({ client }));

    expect(out.refused).toBeNull();
    expect(out.items.map((i) => i.id)).toEqual([ID_A, ID_B]);
    expect(out.items[0]).toMatchObject({
      title: 'Rivière Exemple',
      author: 'Auteure Test',
      year: 2023,
      url: FILE_A,
      pageUrl: PAGE_A,
      version: 'etag-a',
      sizeBytes: 2156252,
      updatedAt: '2026-05-25',
      format: 'pdf',
      bbox: [-76.2, 46.3, -75.8, 46.7],
      bboxPrecision: 'river',
      region: 'CA-QC',
    });
    // Bryson (ruisseau) is not in the (empty) name lookup: located by region.
    expect(out.items[1]).toMatchObject({ url: FILE_B, bboxPrecision: 'region' });
    expect(out.diff.added).toHaveLength(2);
    expect(out.warnings).toEqual([
      'listing: dropped map sans-auteur-2001: no author to credit',
      'listing: dropped map with an unusable id "not-a-uuid"',
      'listing: payload lists 2 maps but the page links 3',
    ]);

    // Politeness: identified, robots first, and never a PDF body or the API.
    for (const s of sent) expect(s.init.headers['User-Agent']).toBe(UA);
    expect(sent[0]?.url).toBe('https://cartespleinair.org/robots.txt');
    const files = sent.filter((s) => s.url.endsWith('.pdf'));
    expect(files.map((s) => s.init.method)).toEqual(['HEAD', 'HEAD']);
    expect(sent.some((s) => s.url.includes('/api/'))).toBe(false);
    const pages = sent.filter((s) => s.url.startsWith('https://cartespleinair.org/cartes/'));
    expect(pages.map((s) => [s.init.method, s.init.redirect])).toEqual([
      ['HEAD', 'manual'],
      ['HEAD', 'manual'],
    ]);
    // ≤ 1 request per second per host: 4 site requests take ≥ 3 intervals.
    expect(sent.filter((s) => s.url.startsWith('https://cartespleinair.org'))).toHaveLength(4);
    expect(elapsed()).toBeGreaterThanOrEqual(3 * 1100);

    // Every river is now in the gazetteer, matched or not.
    expect(out.gazetteer).toEqual({
      'aaaaaaaa-0000-4000-8000-000000000001': {
        name: 'Exemple',
        regions: ['qc:07'],
        match: {
          bbox: [-76.2, 46.3, -75.8, 46.7],
          evidence: 'CGNDB feature EX1 "Rivière Exemple"',
        },
        checkedAt: '2026-10-14',
      },
      'aaaaaaaa-0000-4000-8000-000000000002': {
        name: 'Du Nord (Exemple)',
        regions: ['qc:15'],
        checkedAt: '2026-10-14',
      },
      'aaaaaaaa-0000-4000-8000-000000000003': {
        name: 'Bryson (ruisseau)',
        regions: ['qc:07', 'ca:on'],
        checkedAt: '2026-10-14',
      },
    });
  });

  it('costs one HEAD per map the next week: known files and rivers are not asked again', async () => {
    const first = harness(baseRoutes());
    const before = await crawlCartesPleinAir(input({ client: first.client }));

    const again = harness(baseRoutes());
    const out = await crawlCartesPleinAir(
      input({ client: again.client, previous: before.items, gazetteer: before.gazetteer }),
    );
    expect(out.diff.unchanged).toBe(2);
    expect(out.items).toEqual(before.items);
    expect(again.sent.filter((s) => s.url.endsWith('.pdf'))).toEqual([]);
    expect(again.sent.filter((s) => s.url.includes('geogratis'))).toEqual([]);
  });

  it('notices a republished map (new file) and re-reads only that file', async () => {
    const first = await crawlCartesPleinAir(input({ client: harness(baseRoutes()).client }));
    const routes = baseRoutes();
    routes[PAGE_A] = redirect(FILE_A2);
    const { client, sent } = harness(routes);
    const out = await crawlCartesPleinAir(
      input({ client, previous: first.items, gazetteer: first.gazetteer }),
    );
    expect(out.diff.republished.map((c) => [c.after.id, c.after.version])).toEqual([
      [ID_A, 'etag-a2'],
    ]);
    expect(sent.filter((s) => s.url.endsWith('.pdf')).map((s) => s.url)).toEqual([FILE_A2]);
  });

  it('refuses to publish a crawl that would withdraw too much at once', async () => {
    const first = await crawlCartesPleinAir(input({ client: harness(baseRoutes()).client }));
    const routes = baseRoutes();
    routes[PAGE_B] = res(404);
    const out = await crawlCartesPleinAir(
      input({ client: harness(routes).client, previous: first.items }),
    );
    expect(out.diff.removed.map((i) => i.id)).toEqual([ID_B]);
    expect(out.refused).toBe('the crawl would withdraw 1 of 2 maps (50 %, limit 20 %)');
    expect(out.warnings).toContain(`${SLUG_B}: map page answered HTTP 404; left out`);
  });

  it('keeps last week’s row when a page fails transiently, and drops an off-site redirect', async () => {
    const first = await crawlCartesPleinAir(input({ client: harness(baseRoutes()).client }));
    const routes = baseRoutes();
    routes[PAGE_A] = res(503);
    routes[PAGE_B] = redirect('https://elsewhere.example/b.pdf');
    const out = await crawlCartesPleinAir(
      input({ client: harness(routes).client, previous: first.items, gazetteer: first.gazetteer }),
    );
    expect(out.items.map((i) => i.id)).toEqual([ID_A]);
    expect(out.items[0]).toEqual(first.items[0]);
    expect(out.warnings).toContain(`${SLUG_A}: HTTP 503; kept last week's row`);
    expect(out.warnings).toContain(
      `${SLUG_B}: redirects off the publisher's site (https://elsewhere.example/b.pdf); left out`,
    );
  });

  it('leaves out a page that is not a redirect, a file that is not a PDF, or a 3xx without Location', async () => {
    const routes = baseRoutes();
    routes[PAGE_A] = res(200, '<html/>', { 'Content-Type': 'text/html' });
    routes[FILE_B] = res(200, '', { 'Content-Type': 'text/html' });
    const out = await crawlCartesPleinAir(input({ client: harness(routes).client }));
    expect(out.items).toEqual([]);
    expect(out.refused).toBe('the crawl found no maps at all');
    expect(out.warnings).toContain(`${SLUG_A}: map page answered HTTP 200; left out`);
    expect(out.warnings).toContain(`${SLUG_B}: file answered HTTP 200 text/html; left out`);

    const noLocation = baseRoutes();
    noLocation[PAGE_A] = res(301);
    // A page that serves the PDF itself is its own file (HEAD only, still).
    noLocation[PAGE_B] = res(200, '', { 'Content-Type': 'application/pdf', ETag: '"direct"' });
    const direct = await crawlCartesPleinAir(input({ client: harness(noLocation).client }));
    expect(direct.warnings).toContain(`${SLUG_A}: 301 without Location; left out`);
    expect(direct.items).toHaveLength(1);
    expect(direct.items[0]).toMatchObject({ url: PAGE_B, version: 'direct' });
  });

  it('uses a cached listing on 304, and caches one that carries validators', async () => {
    const routes = baseRoutes();
    routes[LISTING_URL] = res(200, LISTING, { ETag: '"listing-1"' });
    const first = await crawlCartesPleinAir(input({ client: harness(routes).client }));
    expect(first.listingCache).toEqual({ validators: { etag: '"listing-1"' }, body: LISTING });

    const cached = baseRoutes();
    cached[LISTING_URL] = (init) =>
      init.headers['If-None-Match'] === '"listing-1"' ? res(304) : res(200, '');
    const out = await crawlCartesPleinAir(
      input({
        client: harness(cached).client,
        previous: first.items,
        gazetteer: first.gazetteer,
        ...(first.listingCache !== undefined ? { listingCache: first.listingCache } : {}),
      }),
    );
    expect(out.items).toEqual(first.items);
    expect(out.listingCache).toEqual(first.listingCache);
  });

  it('publishes nothing when the listing is unreachable, disallowed or a partial run', async () => {
    const down = baseRoutes();
    down[LISTING_URL] = res(404);
    expect((await crawlCartesPleinAir(input({ client: harness(down).client }))).refused).toBe(
      'listing answered HTTP 404',
    );

    const blocked = baseRoutes();
    blocked['https://cartespleinair.org/robots.txt'] = res(200, 'User-agent: *\nDisallow: /\n');
    const out = await crawlCartesPleinAir(input({ client: harness(blocked).client }));
    expect(out.refused).toBe('robots.txt disallows the listing page');
    expect(out.items).toEqual([]);

    const failing = baseRoutes();
    failing[LISTING_URL] = res(500);
    expect((await crawlCartesPleinAir(input({ client: harness(failing).client }))).refused).toBe(
      'listing unavailable (HTTP 500)',
    );

    const limited = await crawlCartesPleinAir(
      input({ client: harness(baseRoutes()).client, limit: 1 }),
    );
    expect(limited.items).toHaveLength(1);
    expect(limited.refused).toBe('--limit 1: a partial crawl is never published');
  });

  it('does not remember a failed name lookup as "no match"', async () => {
    const routes = baseRoutes();
    routes[geoRoute('Exemple')] = res(500);
    const out = await crawlCartesPleinAir(input({ client: harness(routes).client }));
    expect(out.gazetteer['aaaaaaaa-0000-4000-8000-000000000001']).toBeUndefined();
    expect(out.warnings).toContain(
      'no name lookup for river "Exemple"; located by region this time',
    );
  });
});
