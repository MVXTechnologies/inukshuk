import index from './__fixtures__/index.json';
import { foldName, nameMatches, parseCragIndex, resolveUid, searchCrags } from './search';

describe('crag index', () => {
  const idx = parseCragIndex(index)!;

  it('parses the published index', () => {
    expect(idx.details).toBe('fixture');
    expect(idx.rows.find((r) => r.name === 'Weir')).toMatchObject({
      uid: 'ob-73f38626da051606',
      routes: 230,
    });
    expect(resolveUid(idx, 'osm-r11876741')).toBe('ob-73f38626da051606');
    expect(resolveUid(idx, 'ob-zzz')).toBe('ob-zzz');
    expect(resolveUid(null, 'a')).toBe('a');
  });

  it('rejects other shapes', () => {
    expect(parseCragIndex({ schema: 2 })).toBeNull();
    expect(parseCragIndex({ schema: 1, details: 'v', cols: ['n'] })).toBeNull();
    expect(
      parseCragIndex({
        schema: 1,
        details: 'v',
        cols: ['i', 'n', 'lng', 'lat'],
        rows: [['a', 'A', 1, 2], ['b'], 'x'],
      })?.rows,
    ).toHaveLength(1);
  });

  it('finds crags by folded name, best match first', () => {
    expect(searchCrags(idx, 'weir', null)[0]?.row.name).toBe('Weir');
    expect(searchCrags(idx, 'val belair', null)[0]?.row.name).toBe('Val-Bélair');
    expect(searchCrags(idx, 'w', null)).toEqual([]);
    const rows = [
      { uid: 'a', name: 'Mont Lac', lng: 0, lat: 0, region: '', cc: '', routes: 3 },
      { uid: 'b', name: 'Lac', lng: 10, lat: 10, region: '', cc: '', routes: 1 },
      { uid: 'c', name: 'Grand Lac', lng: 0, lat: 0.1, region: '', cc: '', routes: 80 },
      { uid: 'd', name: 'Lac Long', lng: 0, lat: 0, region: '', cc: '', routes: 155 },
    ];
    expect(
      searchCrags({ rows }, 'lac', { latitude: 0, longitude: 0 }).map((h) => h.row.uid),
    ).toEqual(['b', 'd', 'c', 'a']);
  });

  it('folds and matches names', () => {
    expect(foldName("Montagne d'Argent")).toBe('montagne d argent');
    expect(nameMatches('Val-Bélair', 'belair')).toBe(true);
    expect(nameMatches('Weir', '')).toBe(true);
    expect(nameMatches('Weir', 'lac')).toBe(false);
  });
});
