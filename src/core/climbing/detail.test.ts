import fixtures from './__fixtures__/crags.json';
import { approachText, filterRoutes, parseCragDetail } from './detail';
import { foldName } from './search';

const weir = () => parseCragDetail(fixtures.Weir);

describe('parseCragDetail', () => {
  it('reads the Weir topo: ordered OSM walls and an OpenBeta sector', () => {
    const d = weir();
    expect(d).not.toBeNull();
    expect(d?.uid).toBe('ob-73f38626da051606');
    expect(d?.access).toEqual({ status: 'unknown' });
    const bw = d?.sectors.find((s) => s.name === 'Black and White');
    expect(bw?.ordered).toBe(true);
    expect(bw?.routes.every((r) => r.pos !== undefined)).toBe(true);
    const ob = d?.sectors.find((s) => s.src === 'ob');
    expect(ob?.ordered).toBe(false);
    expect(d?.listed).toBe(d?.routeCount);
    expect(d?.sources.map((s) => s.src)).toEqual(['ob', 'osm']);
  });

  it('carries no first ascents or OpenBeta text', () => {
    const json = JSON.stringify(fixtures);
    expect(json).not.toMatch(/"fa"|first_ascent|"description"/);
  });

  it('reads a closed crag', () => {
    expect(parseCragDetail(fixtures['Val-Bélair'])?.access.status).toBe('closed');
  });

  it('is defensive', () => {
    expect(parseCragDetail(null)).toBeNull();
    expect(parseCragDetail({ schema: 2 })).toBeNull();
    expect(parseCragDetail({ schema: 1, uid: 'x', name: 'X', lat: 1 })).toBeNull();
    const d = parseCragDetail({
      schema: 1,
      uid: 'x',
      name: 'X',
      lat: 1,
      lng: 2,
      access: { status: 'weird' },
      sectors: [
        { n: 'A', ordered: true, routes: [{ id: 'osm:n1', n: 'One' }, { nope: 1 }] },
        'junk',
      ],
      links: [
        { kind: 'info', url: 'http://insecure.example' },
        { kind: 'topo', url: 'https://ok.example' },
        { kind: 'other', url: 'https://x.example' },
      ],
      approach: { min: 20, text: { fr: 'Texte', en: 3 }, src: 'c2c' },
    });
    expect(d?.access.status).toBe('unknown');
    // An order without positions is not believed.
    expect(d?.sectors[0]?.ordered).toBe(false);
    expect(d?.sectors[0]?.routes).toHaveLength(1);
    expect(d?.links).toEqual([{ kind: 'topo', url: 'https://ok.example', src: 'web' }]);
    expect(d?.approach).toEqual({ min: 20, text: { fr: 'Texte' }, src: 'c2c' });
  });
});

describe('helpers', () => {
  it('picks the approach text in the reader language', () => {
    const a = { src: 'c2c', text: { fr: 'Bonjour', de: 'Hallo' } };
    expect(approachText(a, 'fr')).toEqual({ text: 'Bonjour', lang: 'fr' });
    expect(approachText(a, 'en')).toEqual({ text: 'Bonjour', lang: 'fr' });
    expect(approachText({ src: 'c2c', text: { de: 'Hallo' } }, 'en')).toEqual({
      text: 'Hallo',
      lang: 'de',
    });
    expect(approachText(undefined, 'en')).toBeNull();
  });

  it('filters routes by folded name or grade', () => {
    const routes = weir()?.sectors.flatMap((s) => s.routes) ?? [];
    expect(filterRoutes(routes, 'epee', foldName).map((r) => r.name)).toEqual(
      expect.arrayContaining(["L'épée de Damoclès"]),
    );
    expect(filterRoutes(routes, '', foldName)).toHaveLength(routes.length);
  });
});
