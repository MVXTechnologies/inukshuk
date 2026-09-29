import {
  classifyActivities,
  classifyKind,
  foldText,
  itemActivities,
  itemKind,
  itemMatchesActivity,
  terrainActivities,
} from './classify';

describe('foldText', () => {
  it('lower-cases, strips accents and pads words with spaces', () => {
    expect(foldText('Pêche à la Truite — Lac-Écho')).toBe(' peche a la truite lac echo ');
  });
});

describe('classifyKind', () => {
  it('maps bulk topo sources to topo', () => {
    for (const sourceId of ['usgs-ustopo', 'usfs-fstopo', 'nrcan-cantopo', 'ga-austopo']) {
      expect(classifyKind({ sourceId, category: 'topo', title: 'Moose Lake' })).toBe('topo');
    }
  });

  it('falls back to the legacy category for unknown sources', () => {
    const k = (category: Parameters<typeof classifyKind>[0]['category']) =>
      classifyKind({ sourceId: 'x', category, title: 'Map' });
    expect(k('parks')).toBe('park');
    expect(k('hunting')).toBe('hunting-fishing');
    expect(k('nautical')).toBe('nautical');
    expect(k('aerial')).toBe('aerial');
    expect(k('geological')).toBe('geological');
    expect(k('touristic')).toBe('trail');
    expect(k('river')).toBe('trail');
    expect(k('forest')).toBe('topo');
  });

  it('title hints win over the source: historical editions', () => {
    expect(
      classifyKind({
        sourceId: 'usgs-ustopo',
        category: 'topo',
        title: 'Denver 1906 (Historical)',
      }),
    ).toBe('historical');
    expect(classifyKind({ sourceId: 'x', category: 'topo', title: 'Carte historique' })).toBe(
      'historical',
    );
  });
});

describe('classifyActivities', () => {
  it('never reads activities into a topo sheet title (toponyms are not evidence)', () => {
    for (const title of ['Moose Lake', 'Trail Creek', 'Camp Verde', 'Fishing Bridge', 'Ski Hill']) {
      expect(classifyActivities({ kind: 'topo', title })).toEqual([]);
    }
  });

  it('reads EN and FR keywords on descriptive kinds', () => {
    expect(
      classifyActivities({ kind: 'hunting-fishing', title: 'Chasse à l’orignal — Zone 27' }),
    ).toEqual(['hunting']);
    expect(
      classifyActivities({ kind: 'park', title: 'Sentiers de ski de fond et raquette' }),
    ).toEqual(['ski', 'snowshoe']);
    expect(
      classifyActivities({ kind: 'trail', title: 'Canot-camping, rivière Bonaventure' }),
    ).toEqual(['paddling', 'camping']);
    expect(classifyActivities({ kind: 'trail', title: 'Fatbike & MTB network' })).toEqual([
      'cycling',
    ]);
    expect(classifyActivities({ kind: 'park', title: 'Escalade et via ferrata' })).toEqual([
      'climbing',
    ]);
    expect(classifyActivities({ kind: 'park', title: 'Carte générale' })).toEqual([]);
    expect(classifyActivities({ kind: 'park', title: 'Campground map' })).toEqual(['camping']);
  });

  it('treats VTT as an ATV (Québec usage), not a bike', () => {
    expect(classifyActivities({ kind: 'trail', title: 'Sentiers VTT et quad' })).toEqual([
      'offroad',
    ]);
    expect(classifyActivities({ kind: 'trail', title: 'MVUM — Motor Vehicle Use Map' })).toEqual([
      'offroad',
    ]);
  });

  it('uses generic trail words only when nothing more specific matched', () => {
    expect(classifyActivities({ kind: 'park', title: 'Carte des sentiers' })).toEqual(['hiking']);
    expect(classifyActivities({ kind: 'park', title: 'Snowmobile trails' })).toEqual(['offroad']);
  });

  it('maps generic winter words to ski + snowshoe unless one is named', () => {
    expect(classifyActivities({ kind: 'park', title: 'Carte hiver' })).toEqual(['ski', 'snowshoe']);
    expect(classifyActivities({ kind: 'park', title: 'Winter snowshoe loops' })).toEqual([
      'snowshoe',
    ]);
  });

  it('gives a hunting/fishing map both when neither is named', () => {
    expect(classifyActivities({ kind: 'hunting-fishing', title: 'Secteur Nord' })).toEqual([
      'hunting',
      'fishing',
    ]);
    expect(classifyActivities({ kind: 'hunting-fishing', title: 'Pêche au saumon' })).toEqual([
      'fishing',
    ]);
  });

  it('reads tags on any kind, and the river category means paddling', () => {
    expect(classifyActivities({ kind: 'topo', title: 'Moose Lake', tags: ['kayak'] })).toEqual([
      'paddling',
    ]);
    expect(
      classifyActivities({ kind: 'trail', category: 'river', title: 'Rivière Rouge' }),
    ).toEqual(['paddling']);
  });

  it('matches whole words only', () => {
    // "skiff" contains "ski"; "chassepot" contains "chasse".
    expect(classifyActivities({ kind: 'park', title: 'Skiff harbour, chassepot museum' })).toEqual(
      [],
    );
  });
});

describe('itemKind / itemActivities', () => {
  it('prefers the stored kind, else derives it', () => {
    expect(itemKind({ kind: 'park', sourceId: 'usgs-ustopo', category: 'topo', title: 'x' })).toBe(
      'park',
    );
    expect(itemKind({ sourceId: 'usgs-ustopo', category: 'topo', title: 'x' })).toBe('topo');
  });

  it('uses explicit activities when present, terrain affinity otherwise', () => {
    expect(itemActivities({ activities: ['ski'], terrain: ['mountains'] })).toEqual(['ski']);
    expect(itemActivities({ terrain: ['mountains', 'water'] })).toEqual([
      'hiking',
      'paddling',
      'fishing',
    ]);
    expect(itemActivities({ activities: [], terrain: ['glacier'] })).toEqual(['climbing']);
    expect(itemActivities({})).toEqual([]);
    expect(itemMatchesActivity({ terrain: ['coast'] }, 'paddling')).toBe(true);
    expect(itemMatchesActivity({ terrain: ['coast'] }, 'hiking')).toBe(false);
  });

  it('terrainActivities de-duplicates in vocabulary order; forest implies nothing', () => {
    expect(terrainActivities(['coast', 'water'])).toEqual(['paddling', 'fishing']);
    expect(terrainActivities(['forest'])).toEqual([]);
  });
});
