/**
 * @jest-environment node
 *
 * End to end, offline: the Worker's plan and merge (`handleSearch`) replayed
 * against recorded Photon answers, then the app's parsing and ranking
 * (`src/core/search`). Fixtures in `__fixtures__/photon/` are real answers of
 * photon.komoot.io (2026-10-01), trimmed to the properties we read; each
 * holds the `/search` request and the upstream URL → answer for every call
 * the plan makes. A plan change that asks Photon something else fails here
 * ("no recorded answer"): re-record rather than edit by hand.
 */
import { readFileSync } from 'node:fs';
import { parsePhotonResponse } from '@core/search/photon';
import { rankAndDedupe, type RankedPlace } from '@core/search/rank';
import { handleSearch } from './search';

interface Fixture {
  request: string;
  upstream: Record<string, unknown>;
}

async function search(name: string): Promise<RankedPlace[]> {
  const fx = JSON.parse(
    readFileSync(`${__dirname}/__fixtures__/photon/${name}.json`, 'utf8'),
  ) as Fixture;
  const params = new URLSearchParams(fx.request);
  const res = await handleSearch(
    new Request(`https://tiles.example/search?${fx.request}`),
    {},
    {
      fetch: async (url) => {
        const body = fx.upstream[url];
        if (body === undefined) throw new Error(`no recorded answer for ${url}`);
        return Response.json(body);
      },
      cache: { match: async () => undefined, put: async () => {} },
      waitUntil: () => {},
      now: () => 0,
    },
    {},
  );
  expect(res.status).toBe(200);
  expect(res.headers.get('X-Search-Upstream')).toBe('3/3');
  const origin = { latitude: Number(params.get('lat')), longitude: Number(params.get('lon')) };
  return rankAndDedupe(parsePhotonResponse(await res.json()), params.get('q') ?? '', origin);
}

const names = (ranked: RankedPlace[], n = 5) => ranked.slice(0, n).map((r) => r.place.name);

describe('recorded searches', () => {
  it.each([
    ['katahdin-quebec'],
    ['katahdin-maine'],
    ['katadhin-quebec'],
    ['katadhin-maine'],
    ['katahdin-mount-quebec'],
  ])('%s: Mount Katahdin first', async (fixture) => {
    const ranked = await search(fixture);
    expect(ranked[0]?.place).toMatchObject({ name: 'Mount Katahdin', type: 'mountain' });
  });

  it('katahdin: the mountain, then the other summit and the lake, before streams', async () => {
    const top = await search('katahdin-quebec');
    expect(names(top, 3)).toEqual(['Mount Katahdin', 'Katahdin Hill', 'Katahdin Lake']);
    const types = top.map((r) => r.place.type);
    // Roads named Katahdin come after every outdoor place.
    const firstRoad = types.indexOf('road');
    if (firstRoad >= 0) {
      expect(types.slice(firstRoad).every((t) => t === 'road' || t === 'poi')).toBe(true);
    }
  });

  it('katadhin (typo): no unrelated mountain from the "mount …" expansion', async () => {
    const top = await search('katadhin-quebec');
    expect(names(top)).not.toContain('Mount Suzu');
    expect(names(top)).not.toContain('Rum Mountain');
  });

  it('matterhron (typo): the Swiss–Italian Matterhorn first, with its French name', async () => {
    const [first] = await search('matterhron-quebec');
    expect(first?.place).toMatchObject({ name: 'Matterhorn', altName: 'Cervin', type: 'peak' });
  });

  it('mont st anne: the Mont Sainte-Anne near Québec first', async () => {
    const [first] = await search('mont-st-anne-quebec');
    expect(first?.place).toMatchObject({ name: 'Mont Sainte-Anne', type: 'peak' });
    expect(first?.place.context).toMatch(/^Beaupré/);
  });

  it('lac saint-jean: the lake first, ahead of the towns and regions named after it', async () => {
    const top = await search('lac-saint-jean-quebec');
    expect(top[0]?.place).toMatchObject({ name: 'Lac Saint-Jean', type: 'lake' });
    expect(top[0]?.place.context).toMatch(/Lac-Saint-Jean-Est/);
  });
});
