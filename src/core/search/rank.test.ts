import type { Place } from './place';
import {
  dedupePlaces,
  normalizeName,
  proximityFactor,
  rankAndDedupe,
  rankPlaces,
  textScore,
} from './rank';

const QUEBEC = { latitude: 46.81, longitude: -71.21 };

function place(over: Partial<Place> & Pick<Place, 'id' | 'name'>): Place {
  return { source: 'index', type: 'poi', latitude: 47.08, longitude: -70.93, ...over };
}

describe('normalizeName / textScore', () => {
  it('folds accents, case and separators', () => {
    expect(normalizeName('Mont-Sainte-Anne')).toBe('mont sainte anne');
    expect(normalizeName("L'Île-d'Orléans")).toBe('l ile d orleans');
  });

  it('prefers exact, then prefix, then word prefix, then substring', () => {
    const q = normalizeName('mont sainte anne');
    expect(textScore('Mont-Sainte-Anne', q)).toBe(1);
    expect(textScore('Mont Sainte-Anne Resort', q)).toBe(0.9);
    expect(textScore('Parc du Mont-Sainte-Anne', q)).toBe(0.65);
    expect(textScore('Le Grand Lac', 'lac')).toBe(0.8);
    expect(textScore('Something else', q)).toBe(0.4);
    expect(textScore('Anything', '')).toBe(0.4);
  });
});

describe('proximityFactor', () => {
  it('is 1 nearby or without a position, and decays gently', () => {
    expect(proximityFactor(null)).toBe(1);
    expect(proximityFactor(Number.NaN)).toBe(1);
    expect(proximityFactor(0)).toBe(1);
    expect(proximityFactor(50_000)).toBeCloseTo(0.75);
    expect(proximityFactor(500_000)).toBeGreaterThan(0.5);
    expect(proximityFactor(500_000)).toBeLessThan(0.6);
  });
});

describe('rankPlaces', () => {
  it('puts the peak above the hotel and the street of the same name', () => {
    const ranked = rankPlaces(
      [
        place({ id: 'a', name: 'Mont-Sainte-Anne', type: 'road' }),
        place({ id: 'b', name: 'Hôtel Mont-Sainte-Anne', type: 'poi' }),
        place({ id: 'c', name: 'Mont Sainte-Anne', type: 'peak' }),
      ],
      'mont sainte-anne',
      QUEBEC,
    );
    expect(ranked.map((r) => r.place.id)).toEqual(['c', 'a', 'b']);
    expect(ranked[0]?.distanceM).toBeGreaterThan(20_000);
  });

  it('prefers the nearer of two equal matches', () => {
    const ranked = rankPlaces(
      [
        place({ id: 'far', name: 'Lac Long', type: 'lake', latitude: 50, longitude: -75 }),
        place({ id: 'near', name: 'Lac Long', type: 'lake', latitude: 46.9, longitude: -71.3 }),
      ],
      'lac long',
      QUEBEC,
    );
    expect(ranked.map((r) => r.place.id)).toEqual(['near', 'far']);
  });

  it('matches on the alternate-language name too', () => {
    const [r] = rankPlaces(
      [place({ id: 'x', name: 'Mount Washington', altName: 'Mont Washington', type: 'peak' })],
      'mont washington',
      null,
    );
    expect(r?.score).toBe(1);
    expect(r?.distanceM).toBeNull();
  });

  it('keeps index order on ties', () => {
    const ranked = rankPlaces(
      [place({ id: '1', name: 'Same' }), place({ id: '2', name: 'Same' })],
      'same',
      null,
    );
    expect(ranked.map((r) => r.place.id)).toEqual(['1', '2']);
  });
});

describe('dedupePlaces', () => {
  const wrap = (p: Place) => ({ place: p });

  it('drops the same name within 200 m, in either language', () => {
    const kept = dedupePlaces([
      wrap(place({ id: '1', name: 'Mont Sainte-Anne', type: 'peak' })),
      wrap(place({ id: '2', name: 'Mont-Sainte-Anne', latitude: 47.0805 })),
      wrap(place({ id: '3', name: 'Other', altName: 'Mont Sainte Anne', latitude: 47.0801 })),
      wrap(place({ id: '4', name: 'Mont Sainte-Anne', latitude: 47.09 })),
    ]);
    expect(kept.map((k) => k.place.id)).toEqual(['1', '4']);
  });

  it("drops a lake's point inside the outline of the same lake", () => {
    const kept = dedupePlaces([
      wrap(
        place({
          id: 'way',
          name: 'Lac Saint-Jean',
          type: 'lake',
          latitude: 48.6,
          longitude: -72.1,
          bbox: [-72.4, 48.4, -71.8, 48.9],
        }),
      ),
      wrap(
        place({ id: 'node', name: 'Lac Saint-Jean', type: 'lake', latitude: 48.8, longitude: -72 }),
      ),
      wrap(
        place({ id: 'town', name: 'Lac Saint-Jean', type: 'town', latitude: 48.8, longitude: -72 }),
      ),
    ]);
    expect(kept.map((k) => k.place.id)).toEqual(['way', 'town']);
  });
});

describe('dedupePlaces — linear features', () => {
  it('merges same-named stream segments a few km apart, but not two far streams', () => {
    const stream = (id: string, latitude: number) => ({
      place: place({ id, name: 'Katahdin Stream', type: 'river', latitude, longitude: -68.97 }),
    });
    const kept = dedupePlaces([stream('a', 45.85), stream('b', 45.87), stream('c', 46.2)]);
    expect(kept.map((k) => k.place.id)).toEqual(['a', 'c']);
  });

  it('keeps a peak and a lake of the same name a few km apart', () => {
    const kept = dedupePlaces([
      { place: place({ id: 'p', name: 'Lac Noir', type: 'peak', latitude: 47 }) },
      { place: place({ id: 'l', name: 'Lac Noir', type: 'lake', latitude: 47.02 }) },
    ]);
    expect(kept).toHaveLength(2);
  });
});

describe('rankAndDedupe', () => {
  it('ranks, dedupes and caps', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      place({ id: `p${i}`, name: `Peak ${i}`, type: 'peak', latitude: 47 + i * 0.01 }),
    );
    const out = rankAndDedupe(
      [...many, place({ id: 'dup', name: 'Peak 0', latitude: 47 })],
      'peak',
      null,
      5,
    );
    expect(out).toHaveLength(5);
    expect(out.some((r) => r.place.id === 'dup')).toBe(false);
  });
});
