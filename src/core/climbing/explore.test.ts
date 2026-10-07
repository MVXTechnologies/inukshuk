import fixtures from './__fixtures__/crags.json';
import { cragAreaLabel, cragsFromFeatures } from './explore';

const tiles = [fixtures['Weir tile'], fixtures['Lac Long tile'], fixtures['Val-Bélair tile']];

describe('crags in view', () => {
  it('dedupes, sorts nearest the centre, filters by name, caps', () => {
    const quebecCity = { latitude: 46.81, longitude: -71.21 };
    const out = cragsFromFeatures([...tiles, fixtures['Weir tile'], { properties: {} }], {
      centre: quebecCity,
    });
    expect(out.map((c) => c.name)).toEqual(['Val-Bélair', 'Lac Long', 'Weir']);
    expect(cragsFromFeatures(tiles, { centre: null, text: 'lac' }).map((c) => c.name)).toEqual([
      'Lac Long',
    ]);
    expect(cragsFromFeatures(tiles, { centre: quebecCity, limit: 1 })).toHaveLength(1);
  });

  it('labels the area', () => {
    const out = cragsFromFeatures(tiles, { centre: null });
    expect(cragAreaLabel(out)).toBe('3 crags in this area · 446 routes');
    expect(cragAreaLabel(out.slice(0, 1))).toMatch(/^1 crag in this area/);
    expect(cragAreaLabel([])).toBe('No crags in this area');
  });
});
