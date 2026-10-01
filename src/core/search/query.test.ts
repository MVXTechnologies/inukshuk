import {
  classifyQuery,
  coordinatePlace,
  roundForPrivacy,
  searchLanguage,
  searchQueryString,
} from './query';

describe('classifyQuery', () => {
  it('recognizes empty and too-short queries', () => {
    expect(classifyQuery('')).toEqual({ kind: 'empty' });
    expect(classifyQuery('   ')).toEqual({ kind: 'empty' });
    expect(classifyQuery(' K ')).toEqual({ kind: 'too-short', text: 'K' });
    // One code point, even when it is a surrogate pair.
    expect(classifyQuery('𝔸')).toEqual({ kind: 'too-short', text: '𝔸' });
  });

  it('reads names as text, collapsing whitespace', () => {
    expect(classifyQuery('  lac   Saint-Jean ')).toEqual({ kind: 'text', text: 'lac Saint-Jean' });
    expect(classifyQuery('Ka')).toEqual({ kind: 'text', text: 'Ka' });
  });

  it('reads coordinates in every notation the dialog accepts', () => {
    expect(classifyQuery('46.8139, -71.2082')).toEqual({
      kind: 'coordinates',
      text: '46.8139, -71.2082',
      at: { latitude: 46.8139, longitude: -71.2082 },
    });
    const dms = classifyQuery(`46°48'50"N 71°12'29"W`);
    expect(dms.kind).toBe('coordinates');
    if (dms.kind === 'coordinates') {
      expect(dms.at.latitude).toBeCloseTo(46.8139, 3);
      expect(dms.at.longitude).toBeCloseTo(-71.2081, 3);
    }
  });

  it('does not mistake a number-bearing name for a coordinate', () => {
    expect(classifyQuery('Route 175').kind).toBe('text');
    expect(classifyQuery('46.8').kind).toBe('text');
  });
});

describe('coordinatePlace', () => {
  it('is a coordinates result at the point', () => {
    const p = coordinatePlace({ latitude: 46.8139, longitude: -71.2082 });
    expect(p).toMatchObject({
      source: 'coordinates',
      type: 'coordinates',
      latitude: 46.8139,
      longitude: -71.2082,
    });
    expect(p.id).toBe('coords:46.813900,-71.208200');
    expect(p.name).toMatch(/46\.81/);
  });
});

describe('roundForPrivacy', () => {
  it('rounds to 0.01° (about a kilometre)', () => {
    expect(roundForPrivacy({ latitude: 46.81394, longitude: -71.20821 })).toEqual({
      lat: 46.81,
      lon: -71.21,
    });
  });
});

describe('searchLanguage', () => {
  it('is French for any French locale, English otherwise', () => {
    expect(searchLanguage('fr-CA')).toBe('fr');
    expect(searchLanguage('FR')).toBe('fr');
    expect(searchLanguage('en-US')).toBe('en');
    expect(searchLanguage('de-CH')).toBe('en');
    expect(searchLanguage(null)).toBe('en');
    expect(searchLanguage(undefined)).toBe('en');
  });
});

describe('searchQueryString', () => {
  it('sends the query, both languages, the limit and a rounded location', () => {
    expect(
      searchQueryString({
        text: 'lac Saint-Jean & co',
        lang: 'fr',
        near: { latitude: 46.81394, longitude: -71.20821 },
      }),
    ).toBe('q=lac%20Saint-Jean%20%26%20co&lang=fr&alt=en&limit=15&lat=46.81&lon=-71.21');
  });

  it('omits the location when there is none', () => {
    expect(searchQueryString({ text: 'Chamonix', lang: 'en', near: null, limit: 5 })).toBe(
      'q=Chamonix&lang=en&alt=fr&limit=5',
    );
  });
});
