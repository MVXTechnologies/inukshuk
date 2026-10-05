import fixtures from './__fixtures__/crags.json';
import { downloadable, mainKind, nonEmptyBands, parseBands, parseCragTile, stylesOf } from './crag';

describe('parseCragTile', () => {
  it('reads the Weir tile record (OpenBeta + OSM, with a wall diagram)', () => {
    const weir = parseCragTile(fixtures['Weir tile'] as never);
    expect(weir).toMatchObject({
      uid: 'ob-73f38626da051606',
      name: 'Weir',
      routes: 230,
      sectors: 14,
      access: 'unknown',
      sources: ['ob', 'osm'],
      diagram: true,
      region: 'Laurentides',
    });
    expect(weir?.styles).toEqual(expect.arrayContaining(['sport', 'trad', 'tr']));
    expect(weir?.ranges.r).toEqual([2, 31]);
    expect(weir?.bands.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it('reads a closed crag and boulder ranges', () => {
    expect(parseCragTile(fixtures['Val-Bélair tile'] as never)?.access).toBe('closed');
    const lac = parseCragTile(fixtures['Lac Long tile'] as never);
    expect(lac?.ranges.b).toEqual([4, 8]);
    expect(lac?.diagram).toBe(false);
  });

  it('never invents an open status, and rejects non-crags', () => {
    const f = (p: Record<string, unknown>) =>
      parseCragTile({
        properties: { i: 'x', n: 'X', ...p },
        geometry: { type: 'Point', coordinates: [0, 1] },
      });
    expect(f({})?.access).toBe('unknown');
    expect(f({ a: 0 })?.access).toBe('open');
    expect(f({ a: 9 })?.access).toBe('unknown');
    expect(
      parseCragTile({ properties: { n: 'X' }, geometry: { type: 'Point', coordinates: [0, 1] } }),
    ).toBeNull();
    expect(
      parseCragTile({ properties: { i: 'x', n: 'X' }, geometry: { type: 'LineString' } }),
    ).toBeNull();
  });

  it('decodes style bits and bands', () => {
    expect(stylesOf(1 | 8 | 16)).toEqual(['sport', 'boulder', 'ice']);
    expect(parseBands('4,20,x,-1')).toEqual([4, 20, 0, 0]);
    expect(parseBands(undefined)).toEqual([0, 0, 0, 0]);
    expect(nonEmptyBands([0, 3, 0, 1])).toEqual([1, 3]);
  });

  it('picks the main discipline and refuses downloads of closed crags', () => {
    expect(mainKind({ ranges: { b: [1, 2] }, styles: [] })).toBe('b');
    expect(mainKind({ ranges: {}, styles: [] })).toBeNull();
    expect(downloadable('closed')).toBe(false);
    expect(downloadable('banned')).toBe(false);
    expect(downloadable('unknown')).toBe(true);
  });
});
