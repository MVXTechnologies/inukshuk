/**
 * @jest-environment node
 */
import {
  DEFAULT_PHOTON_URL,
  handleSearch,
  mergeAltNames,
  mergeAnswers,
  searchCacheKey,
  parseSearchParams,
  resetSearchRateLimit,
  SEARCH_USER_AGENT,
  type SearchDeps,
  type SearchEnv,
} from './search';
import { MAX_UPSTREAM_CALLS, PEAK_TAGS, tagsFor, WATER_TAGS } from './searchPlan';

const feature = (id: number, name: string) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-70.93, 47.08] },
  properties: { osm_type: 'N', osm_id: id, osm_key: 'natural', osm_value: 'peak', name },
});

const fc = (...features: unknown[]) => ({ type: 'FeatureCollection', features });

/** A fake upstream + Map-backed cache; records what was fetched. */
function harness(upstream: (url: URL) => Response | Promise<Response>) {
  const store = new Map<string, Response>();
  const calls: { url: URL; headers: Headers }[] = [];
  const pending: Promise<unknown>[] = [];
  let now = 1_000_000;
  const deps: SearchDeps = {
    fetch: async (input, init) => {
      const url = new URL(input);
      calls.push({ url, headers: new Headers(init?.headers) });
      return upstream(url);
    },
    cache: {
      match: async (req) => store.get(req.url)?.clone(),
      put: async (req, res) => {
        store.set(req.url, res);
      },
    },
    waitUntil: (p) => {
      pending.push(p);
    },
    now: () => now,
  };
  return {
    deps,
    calls,
    store,
    settle: () => Promise.all(pending),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const CORS = { 'Access-Control-Allow-Origin': '*' };

function get(query: string, ip = '203.0.113.7'): Request {
  return new Request(`https://tiles.example/search?${query}`, {
    headers: { 'CF-Connecting-IP': ip },
  });
}

beforeEach(() => resetSearchRateLimit());

describe('parseSearchParams', () => {
  const parse = (q: string) => parseSearchParams(new URL(`https://x/search?${q}`));

  it('normalizes and bounds every parameter', () => {
    expect(
      parse('q=%20lac%20%20Saint-Jean%20&lang=FR&alt=en&limit=50&lat=46.8139&lon=-71.2082'),
    ).toEqual({ q: 'lac Saint-Jean', lang: 'fr', alt: 'en', limit: 20, lat: 46.81, lon: -71.21 });
    expect(parse('q=ab&lang=xx&alt=xx&limit=0')).toEqual({
      q: 'ab',
      lang: 'default',
      alt: null,
      limit: 1,
      lat: null,
      lon: null,
    });
    expect(parse('q=ab&limit=nope&lat=95&lon=0')).toMatchObject({ limit: 10, lat: null });
    expect(parse('q=ab&lang=fr&alt=fr')).toMatchObject({ alt: null });
    expect(parse('q=ab&lat=46')).toMatchObject({ lat: null, lon: null });
  });

  it('rejects a missing, one-character or overlong query', () => {
    expect(parse('')).toMatch(/at least 2/);
    expect(parse('q=%20a%20')).toMatch(/at least 2/);
    expect(parse(`q=${'a'.repeat(201)}`)).toMatch(/too long/);
  });
});

describe('mergeAltNames', () => {
  it('adds alt_name only where the other language differs', () => {
    const merged = mergeAltNames(
      fc(feature(1, 'Mont Washington'), feature(2, 'Katahdin'), { properties: null }),
      fc(feature(1, 'Mount Washington'), feature(2, 'Katahdin'), feature(3, 'Unrelated')),
    );
    const props = (merged.features as { properties: Record<string, unknown> | null }[]).map(
      (f) => f.properties?.alt_name,
    );
    expect(props).toEqual(['Mount Washington', undefined, undefined]);
  });
});

describe('handleSearch', () => {
  it('forwards to Photon with our User-Agent, both languages and a rounded location', async () => {
    const h = harness((url) =>
      Response.json(
        url.searchParams.get('lang') === 'en'
          ? fc(feature(1, 'Mount Sainte-Anne'))
          : fc(feature(1, 'Mont Sainte-Anne')),
      ),
    );
    const res = await handleSearch(
      get('q=Mont-Sainte-Anne&lang=fr&alt=en&lat=46.81394&lon=-71.20821&limit=5'),
      {},
      h.deps,
      CORS,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('X-Search-Cache')).toBe('MISS');
    expect(res.headers.get('X-Search-Upstream')).toBe('3/3');
    const body = (await res.json()) as ReturnType<typeof fc>;
    // Three answers, one OSM object: one feature, in French, with its English name.
    expect(body.features).toEqual([
      expect.objectContaining({
        properties: expect.objectContaining({
          name: 'Mont Sainte-Anne',
          alt_name: 'Mount Sainte-Anne',
        }) as unknown,
      }),
    ]);

    expect(h.calls).toHaveLength(3);
    const [general, expanded, core] = h.calls;
    expect(general?.url.origin + general!.url.pathname).toBe(DEFAULT_PHOTON_URL);
    const params = general!.url.searchParams;
    expect(params.get('q')).toBe('Mont-Sainte-Anne');
    expect(params.get('limit')).toBe('5');
    expect(params.get('lang')).toBe('fr');
    expect(params.get('lat')).toBe('46.81');
    expect(params.get('lon')).toBe('-71.21');
    // Shops, offices and workshops never take a result slot.
    expect(params.getAll('osm_tag')).toEqual(['!shop', '!office', '!craft']);
    // The summit-only query keeps the generic word ("Mont").
    expect(expanded?.url.searchParams.get('q')).toBe('Mont-Sainte-Anne');
    expect(expanded?.url.searchParams.get('lang')).toBe('fr');
    expect(expanded?.url.searchParams.getAll('osm_tag')).toEqual(PEAK_TAGS);
    // The distinctive words alone, in the second language.
    expect(core?.url.searchParams.get('q')).toBe('Sainte Anne');
    expect(core?.url.searchParams.get('lang')).toBe('en');
    expect(core?.url.searchParams.getAll('osm_tag')).toEqual(tagsFor('outdoor'));
    for (const c of h.calls) {
      expect(c.headers.get('User-Agent')).toBe(SEARCH_USER_AGENT);
      expect(c.url.searchParams.get('lat')).toBe('46.81');
    }
  });

  it('uses PHOTON_URL, omits lang=default, and can skip the second language', async () => {
    const h = harness(() => Response.json(fc()));
    const env: SearchEnv = {
      PHOTON_URL: 'http://nas.local:2322/api',
      PHOTON_ALT_NAMES: '0',
      PHOTON_VARIANTS: '0',
      PHOTON_OSM_TAGS: '',
    };
    await handleSearch(get('q=Chamonix&alt=fr'), env, h.deps, CORS);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.url.toString()).toBe('http://nas.local:2322/api?q=Chamonix&limit=10');
  });

  it('takes its osm_tag filters from PHOTON_OSM_TAGS, dropping malformed ones', async () => {
    const h = harness(() => Response.json(fc()));
    const env: SearchEnv = { PHOTON_OSM_TAGS: ' !shop , natural:peak, bad tag, !x&y=1 ' };
    await handleSearch(get('q=Chamonix'), env, h.deps, CORS);
    expect(h.calls[0]?.url.searchParams.getAll('osm_tag')).toEqual(['!shop', 'natural:peak']);
    // The variants carry their own filters.
    expect(h.calls[1]?.url.searchParams.getAll('osm_tag')).toEqual(PEAK_TAGS);
    // A different filter set is a different cache entry.
    await h.settle();
    await handleSearch(get('q=Chamonix'), {}, h.deps, CORS);
    expect(h.calls).toHaveLength(6);
  });

  it('answers a repeat (any case or spacing) from the cache without going upstream', async () => {
    const h = harness(() => Response.json(fc(feature(1, 'Katahdin'))));
    await handleSearch(get('q=Katahdin&lang=en'), {}, h.deps, CORS);
    await h.settle();
    expect(h.store.size).toBe(1);
    const again = await handleSearch(get('q=%20katahdin%20&lang=en'), {}, h.deps, CORS);
    expect(again.status).toBe(200);
    expect(again.headers.get('X-Search-Cache')).toBe('HIT');
    expect(again.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(((await again.json()) as ReturnType<typeof fc>).features).toHaveLength(1);
    expect(h.calls).toHaveLength(3);
  });

  it('rate-limits each IP per minute (cache hits are free)', async () => {
    const h = harness(() => Response.json(fc()));
    const env: SearchEnv = { SEARCH_RATE_PER_MIN: '2' };
    expect((await handleSearch(get('q=aa'), env, h.deps, CORS)).status).toBe(200);
    expect((await handleSearch(get('q=bb'), env, h.deps, CORS)).status).toBe(200);
    const limited = await handleSearch(get('q=cc'), env, h.deps, CORS);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    expect(limited.headers.get('Cache-Control')).toBe('no-store');
    // Another client is not affected.
    expect((await handleSearch(get('q=cc', '198.51.100.1'), env, h.deps, CORS)).status).toBe(200);
    // A cached answer still flows.
    await h.settle();
    expect((await handleSearch(get('q=aa'), env, h.deps, CORS)).status).toBe(200);
    // The next minute opens a new window.
    h.advance(60_000);
    expect((await handleSearch(get('q=dd'), env, h.deps, CORS)).status).toBe(200);
  });

  it('defers to a rate-limiting binding when there is one', async () => {
    const h = harness(() => Response.json(fc()));
    const keys: string[] = [];
    const env: SearchEnv = {
      SEARCH_LIMITER: {
        limit: async ({ key }) => {
          keys.push(key);
          return { success: false };
        },
      },
    };
    expect((await handleSearch(get('q=aa'), env, h.deps, CORS)).status).toBe(429);
    expect(keys).toEqual(['203.0.113.7']);
    expect(h.calls).toHaveLength(0);
  });

  it('turns upstream failures into uncached errors', async () => {
    const cases: [() => Response | Promise<Response>, number][] = [
      [() => new Response('slow down', { status: 429 }), 503],
      [() => new Response('bad', { status: 400 }), 400],
      [() => new Response('boom', { status: 500 }), 502],
      [() => Response.json({ not: 'geojson' }), 502],
      [() => Promise.reject(new TypeError('network down')), 504],
    ];
    for (const [upstream, status] of cases) {
      const h = harness(upstream);
      const res = await handleSearch(get('q=Chamonix'), {}, h.deps, CORS);
      expect(res.status).toBe(status);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
      await h.settle();
      expect(h.store.size).toBe(0);
    }
  });

  it('still answers when only the second language fails', async () => {
    const h = harness((url) =>
      url.searchParams.get('lang') === 'en'
        ? new Response('nope', { status: 500 })
        : Response.json(fc(feature(1, 'Chamonix-Mont-Blanc'))),
    );
    const res = await handleSearch(get('q=Chamonix&lang=fr&alt=en'), {}, h.deps, CORS);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { features: { properties: Record<string, unknown> }[] };
    expect(body.features[0]?.properties.alt_name).toBeUndefined();
    // A poorer answer is served, not cached for a day.
    expect(res.headers.get('X-Search-Upstream')).toBe('2/3');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    await h.settle();
    expect(h.store.size).toBe(0);
  });

  it('fails when the query as typed fails, even if a variant answered', async () => {
    const h = harness((url) =>
      url.searchParams.getAll('osm_tag').includes('!shop')
        ? new Response('slow down', { status: 429 })
        : Response.json(fc(feature(1, 'Mont Blanc'))),
    );
    const res = await handleSearch(get('q=Mont Blanc'), {}, h.deps, CORS);
    expect(res.status).toBe(503);
  });

  it('never makes more than three upstream calls, and none on a cache hit', async () => {
    const h = harness(() => Response.json(fc(feature(1, 'Mount Katahdin'))));
    for (const q of ['katahdin', 'katahdin mount', 'lac saint-jean', 'mont st anne', 'mount']) {
      const before = h.calls.length;
      await handleSearch(get(`q=${encodeURIComponent(q)}&lang=en&alt=fr`), {}, h.deps, CORS);
      expect(h.calls.length - before).toBeLessThanOrEqual(MAX_UPSTREAM_CALLS);
      await h.settle();
    }
    const total = h.calls.length;
    // "Katahdin Mount" is the same plan as "mount katahdin": one cache entry.
    const hit = await handleSearch(get('q=Mount%20KATAHDIN&lang=en&alt=fr'), {}, h.deps, CORS);
    expect(hit.headers.get('X-Search-Cache')).toBe('HIT');
    expect(h.calls).toHaveLength(total);
  });

  it('refuses bad requests without going upstream', async () => {
    const h = harness(() => Response.json(fc()));
    expect((await handleSearch(get('q=a'), {}, h.deps, CORS)).status).toBe(400);
    const post = new Request('https://tiles.example/search?q=abc', { method: 'POST' });
    expect((await handleSearch(post, {}, h.deps, CORS)).status).toBe(405);
    expect(h.calls).toHaveLength(0);
  });
});

describe('searchCacheKey', () => {
  const params = (q: string) => {
    const p = parseSearchParams(new URL(`https://x/search?q=${encodeURIComponent(q)}&lang=en`));
    if (typeof p === 'string') throw new Error(p);
    return p;
  };

  it('folds case and the position of the generic word', () => {
    const key = (q: string) => searchCacheKey(params(q), 'fr').url;
    expect(key('Katahdin Mount')).toBe(key('mount katahdin'));
    expect(key('Saint-Jean lac')).toBe(key('lac saint jean'));
    expect(key('katahdin')).not.toBe(key('mount katahdin'));
  });

  it('keeps plain (no variants) answers apart from full ones', () => {
    const p = params('katahdin');
    expect(searchCacheKey(p, null, [], false).url).not.toBe(searchCacheKey(p, null, []).url);
  });
});

describe('mergeAnswers', () => {
  const answer = (role: 'general' | 'expanded' | 'core', lang: string, ...features: unknown[]) => ({
    query: { role, text: 'x', lang, tags: 'general' as const },
    body: fc(...features),
  });

  it('interleaves, drops repeated OSM objects and names them in both languages', () => {
    const merged = mergeAnswers(
      [
        answer('general', 'en', feature(1, 'Katahdin Stream'), feature(2, 'Katahdin Lake')),
        answer('expanded', 'en', feature(3, 'Mount Katahdin'), feature(1, 'Katahdin Stream')),
        answer('core', 'fr', feature(3, 'Mont Katahdin'), feature(4, 'Lac Katahdin')),
      ],
      'en',
    );
    const props = (merged.features as { properties: Record<string, unknown> }[]).map(
      (f) => `${String(f.properties.name)}|${String(f.properties.alt_name ?? '')}`,
    );
    // The French copy of Mount Katahdin only names it; Lac Katahdin is only in French.
    expect(props).toEqual([
      'Katahdin Stream|',
      'Mount Katahdin|Mont Katahdin',
      'Lac Katahdin|',
      'Katahdin Lake|',
    ]);
  });

  it('copes with no answers', () => {
    expect(mergeAnswers([], 'en')).toEqual({ type: 'FeatureCollection', features: [] });
  });

  it('water searches are restricted to water', () => {
    expect(WATER_TAGS).toContain('water');
  });
});
