import { parseLinkOutCollections, placeActivities } from './collections';

const place = (overrides: Record<string, unknown> = {}) => ({
  id: 'sepaq-pq-jac',
  name: 'Parc national de la Jacques-Cartier',
  type: 'National park',
  latitude: 47.2922,
  longitude: -71.3485,
  url: 'https://www.sepaq.com/pq/jac/',
  ...overrides,
});

const collection = (overrides: Record<string, unknown> = {}) => ({
  id: 'sepaq',
  name: 'Parcs Québec',
  publisher: 'Sépaq',
  blurb: 'Maps on sepaq.com',
  homepage: 'https://www.sepaq.com/',
  places: [place()],
  ...overrides,
});

describe('parseLinkOutCollections', () => {
  it('parses a bare array verbatim', () => {
    const { collections, warnings } = parseLinkOutCollections([collection()]);
    expect(warnings).toEqual([]);
    expect(collections).toEqual([collection()]);
  });

  it('accepts a { collections } wrapper', () => {
    expect(parseLinkOutCollections({ collections: [collection()] }).collections).toHaveLength(1);
  });

  it('never throws on garbage', () => {
    for (const raw of [null, 3, 'x', {}, { collections: 'no' }]) {
      const { collections, warnings } = parseLinkOutCollections(raw);
      expect(collections).toEqual([]);
      expect(warnings.length).toBeGreaterThan(0);
    }
  });

  it('drops malformed places one by one and keeps the rest', () => {
    const { collections, warnings } = parseLinkOutCollections([
      collection({
        places: [
          place(),
          place({ id: 'Bad Id' }),
          place({ id: 'no-name', name: ' ' }),
          place({ id: 'no-type', type: undefined }),
          place({ id: 'http', url: 'http://www.sepaq.com/pq/x/' }),
          place({ id: 'js', url: 'javascript:alert(1)' }),
          place({ id: 'far', latitude: 95 }),
          place({ id: 'nan', longitude: Number.NaN }),
          place(),
          'nope',
        ],
      }),
    ]);
    expect(collections[0]?.places.map((p) => p.id)).toEqual(['sepaq-pq-jac']);
    expect(warnings).toHaveLength(9);
  });

  it('keeps known activities only, in vocabulary order', () => {
    const { collections } = parseLinkOutCollections([
      collection({ places: [place({ activities: ['fishing', 'jetpack', 'hunting'] })] }),
    ]);
    expect(collections[0]?.places[0]?.activities).toEqual(['hunting', 'fishing']);
  });

  it('drops collections missing a header field, with no places, or duplicated', () => {
    const { collections, warnings } = parseLinkOutCollections([
      collection(),
      collection(),
      collection({ id: 'x', homepage: 'ftp://nope' }),
      collection({ id: 'y', places: [] }),
      collection({ id: 'Z!' }),
      null,
    ]);
    expect(collections.map((c) => c.id)).toEqual(['sepaq']);
    expect(warnings).toHaveLength(5);
  });
});

describe('placeActivities', () => {
  it('uses the place’s own activities, else its type’s defaults', () => {
    expect(placeActivities({ type: 'Wildlife reserve' })).toEqual(['hunting', 'fishing']);
    expect(placeActivities({ type: 'National park' })).toEqual(['hiking', 'camping']);
    expect(placeActivities({ type: 'Marine park' })).toEqual(['paddling']);
    expect(placeActivities({ type: 'ZEC' })).toEqual(['hunting', 'fishing']);
    expect(placeActivities({ type: 'Museum' })).toEqual([]);
    expect(placeActivities({ type: 'National park', activities: ['ski'] })).toEqual(['ski']);
  });
});
