import type { Place } from './place';
import {
  BAND_OTHER,
  BAND_OUTDOOR,
  BAND_PEAK,
  BAND_SETTLEMENT,
  BAND_TRAIL,
  BAND_UNMATCHED,
  BAND_WATER,
  dedupePlaces,
  placeBand,
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

  it('scores whole names above partial ones, and 0 when a word is missing', () => {
    expect(textScore('Mont-Sainte-Anne', 'mont sainte anne')).toBe(1);
    expect(textScore('Mont Sainte-Anne Resort', 'mont sainte anne')).toBeLessThan(1);
    expect(textScore('Mont Sainte-Anne Resort', 'mont sainte anne')).toBeGreaterThan(0.8);
    expect(textScore('Something else', 'mont sainte anne')).toBe(0);
    expect(textScore('Anything', '')).toBe(0);
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

  it('puts a far-away town above an equally far hamlet with the exact name', () => {
    // Live "Chamonix" from Québec: everything is thousands of km away.
    const ranked = rankPlaces(
      [
        place({ id: 'za', name: 'Chamonix', type: 'hamlet', latitude: -33.9, longitude: 18.9 }),
        place({
          id: 'fr',
          name: 'Chamonix-Mont-Blanc',
          type: 'town',
          latitude: 45.92,
          longitude: 6.87,
        }),
      ],
      'Chamonix',
      QUEBEC,
    );
    expect(ranked[0]?.place.id).toBe('fr');
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
    expect(r?.score).toBe(BAND_PEAK + 1);
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

  it('merges a campground mapped twice a few hundred metres apart', () => {
    const camp = (id: string, latitude: number) => ({
      place: place({ id, name: 'Camping Mont-Sainte-Anne', type: 'campground', latitude }),
    });
    expect(dedupePlaces([camp('a', 47.12), camp('b', 47.1236)]).map((k) => k.place.id)).toEqual([
      'a',
    ]);
  });

  it('keeps a peak and a lake of the same name a few km apart', () => {
    const kept = dedupePlaces([
      { place: place({ id: 'p', name: 'Lac Noir', type: 'peak', latitude: 47 }) },
      { place: place({ id: 'l', name: 'Lac Noir', type: 'lake', latitude: 47.02 }) },
    ]);
    expect(kept).toHaveLength(2);
  });
});

describe('placeBand', () => {
  const weak = { score: 0.7, strong: false };
  const strong = { score: 1, strong: true };

  it('orders peaks, water, trails, parks, towns, then roads', () => {
    expect(placeBand('peak', weak, null)).toBe(BAND_PEAK);
    expect(placeBand('mountain', weak, null)).toBe(BAND_PEAK);
    expect(placeBand('range', weak, null)).toBe(BAND_PEAK);
    expect(placeBand('volcano', weak, null)).toBe(BAND_PEAK);
    expect(placeBand('lake', weak, null)).toBe(BAND_WATER);
    expect(placeBand('river', weak, null)).toBe(BAND_WATER);
    expect(placeBand('trail', weak, null)).toBe(BAND_TRAIL);
    expect(placeBand('trailhead', weak, null)).toBe(BAND_TRAIL);
    expect(placeBand('campground', weak, null)).toBe(BAND_OUTDOOR);
    expect(placeBand('hut', weak, null)).toBe(BAND_OUTDOOR);
    expect(placeBand('village', weak, null)).toBe(BAND_SETTLEMENT);
    expect(placeBand('road', weak, null)).toBe(BAND_OTHER);
    expect(placeBand('poi', weak, null)).toBe(BAND_OTHER);
  });

  it('lifts a strong match one band, never above the top', () => {
    expect(placeBand('road', strong, null)).toBe(BAND_SETTLEMENT);
    expect(placeBand('lake', strong, null)).toBe(BAND_PEAK);
    expect(placeBand('peak', strong, null)).toBe(BAND_PEAK);
  });

  it('puts water first for a water word', () => {
    expect(placeBand('lake', weak, 'water')).toBe(BAND_PEAK);
    expect(placeBand('peak', weak, 'water')).toBe(BAND_WATER);
    expect(placeBand('trail', weak, 'water')).toBe(BAND_TRAIL);
  });

  it('sinks a name that does not match', () => {
    expect(placeBand('peak', { score: 0, strong: false }, null)).toBe(BAND_UNMATCHED);
  });
});

describe('rankPlaces — bands', () => {
  it('peak, lake, trail, park, town, road — whatever the index order', () => {
    const ranked = rankPlaces(
      [
        place({ id: 'road', name: 'Katahdin Avenue', type: 'road' }),
        place({ id: 'town', name: 'Katahdin Village', type: 'village' }),
        place({ id: 'park', name: 'Katahdin Woods', type: 'park' }),
        place({ id: 'trail', name: 'Katahdin Ridge Trail', type: 'trail' }),
        place({ id: 'lake', name: 'Katahdin Pond East', type: 'lake' }),
        place({ id: 'peak', name: 'Katahdin North Peak', type: 'peak' }),
      ],
      'katahdin',
      QUEBEC,
    );
    expect(ranked.map((r) => r.place.id)).toEqual([
      'peak',
      'lake',
      'trail',
      'park',
      'town',
      'road',
    ]);
  });

  it('finds the mountain without its generic word, in any order, with a typo', () => {
    const places = [
      place({ id: 'stream', name: 'Katahdin Stream', type: 'river' }),
      place({ id: 'mtn', name: 'Mount Katahdin', type: 'mountain', latitude: 45.9 }),
      place({ id: 'road', name: 'Katahdin Avenue', type: 'road' }),
    ];
    for (const q of ['katahdin', 'katadhin', 'katahdin mount', 'mt katadhin']) {
      expect(rankPlaces(places, q, QUEBEC)[0]?.place.id).toBe('mtn');
    }
  });

  it('lets a whole-name match lift one band, but not past an equal match there', () => {
    // A lake called exactly what was typed lifts into the peak band…
    const ranked = rankPlaces(
      [
        place({ id: 'peak', name: 'Noir Ouest', type: 'peak' }),
        place({ id: 'lake', name: 'Lac Noir', type: 'lake' }),
        place({ id: 'summit', name: 'Mont Noir', type: 'peak', latitude: 47.0801 }),
      ],
      'noir',
      null,
    );
    // …where the peak of the same name still comes first; the partial peak last.
    expect(ranked.map((r) => r.place.id)).toEqual(['summit', 'lake', 'peak']);
  });

  it('keeps proximity as the tie-break inside a band', () => {
    const ranked = rankPlaces(
      [
        place({ id: 'far', name: 'Mont Blanc', type: 'peak', latitude: 45.83, longitude: 6.86 }),
        place({ id: 'near', name: 'Mont Blanc', type: 'peak', latitude: 46.2, longitude: -74.3 }),
      ],
      'mont blanc',
      QUEBEC,
    );
    expect(ranked.map((r) => r.place.id)).toEqual(['near', 'far']);
  });

  it('a water word puts the lake above the peak of the same name', () => {
    const places = [
      place({ id: 'peak', name: 'Mont Jacques-Cartier', type: 'peak' }),
      place({ id: 'lake', name: 'Lac Jacques-Cartier', type: 'lake' }),
    ];
    expect(rankPlaces(places, 'lac jacques cartier', null)[0]?.place.id).toBe('lake');
    expect(rankPlaces(places, 'jacques cartier', null)[0]?.place.id).toBe('peak');
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

  it('drops names that do not match when something does', () => {
    const out = rankAndDedupe(
      [
        place({ id: 'suzu', name: 'Mount Suzu', type: 'peak' }),
        place({ id: 'k', name: 'Mount Katahdin', type: 'mountain' }),
      ],
      'katadhin',
      null,
    );
    expect(out.map((r) => r.place.id)).toEqual(['k']);
  });

  it('keeps the index answers when none matches (a name we do not see)', () => {
    const out = rankAndDedupe(
      [place({ id: 'x', name: 'Cervin', type: 'peak' })],
      'matterhorn',
      null,
    );
    expect(out.map((r) => r.place.id)).toEqual(['x']);
  });
});
