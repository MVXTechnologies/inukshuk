import { dedupeLabel, pickNominatimName } from './regionName';

// ---------------------------------------------------------------------------
// Realistic Nominatim jsonv2 reverse-geocoding fixtures (zoom=12).
// ---------------------------------------------------------------------------

/** Center inside a town boundary — the common case for a Laurentides download. */
const TOWN_FIXTURE = {
  place_id: 332462849,
  licence: 'Data © OpenStreetMap contributors, ODbL 1.0. http://osm.org/copyright',
  osm_type: 'relation',
  osm_id: 8508537,
  lat: '45.9518',
  lon: '-74.1370',
  category: 'boundary',
  type: 'administrative',
  place_rank: 16,
  importance: 0.4211,
  addresstype: 'town',
  name: 'Sainte-Adèle',
  display_name: "Sainte-Adèle, Les Pays-d'en-Haut, Laurentides, Québec, Canada",
  address: {
    town: 'Sainte-Adèle',
    county: "Les Pays-d'en-Haut",
    region: 'Laurentides',
    state: 'Québec',
    'ISO3166-2-lvl4': 'CA-QC',
    country: 'Canada',
    country_code: 'ca',
  },
  boundingbox: ['45.8964', '46.0271', '-74.2439', '-74.0563'],
};

/** Center on a named lake — the hit itself is a natural feature. */
const LAKE_FIXTURE = {
  place_id: 297204521,
  licence: 'Data © OpenStreetMap contributors, ODbL 1.0. http://osm.org/copyright',
  osm_type: 'way',
  osm_id: 33390027,
  lat: '46.2472',
  lon: '-74.6094',
  category: 'natural',
  type: 'water',
  place_rank: 22,
  importance: 0.184,
  addresstype: 'water',
  name: 'Lac Tremblant',
  display_name: 'Lac Tremblant, Mont-Tremblant, Les Laurentides, Laurentides, Québec, Canada',
  address: {
    water: 'Lac Tremblant',
    town: 'Mont-Tremblant',
    county: 'Les Laurentides',
    region: 'Laurentides',
    state: 'Québec',
    country: 'Canada',
    country_code: 'ca',
  },
  boundingbox: ['46.2103', '46.2841', '-74.6491', '-74.5697'],
};

/** Center in the backcountry — only an unorganized territory / county resolves. */
const BACKCOUNTRY_FIXTURE = {
  place_id: 331815228,
  osm_type: 'relation',
  osm_id: 6516432,
  lat: '47.4521',
  lon: '-73.8812',
  category: 'boundary',
  type: 'administrative',
  place_rank: 12,
  addresstype: 'county',
  name: 'Lac-Ashuapmushuan',
  display_name: 'Lac-Ashuapmushuan, Le Domaine-du-Roy, Saguenay–Lac-Saint-Jean, Québec, Canada',
  address: {
    county: 'Le Domaine-du-Roy',
    region: 'Saguenay–Lac-Saint-Jean',
    state: 'Québec',
    country: 'Canada',
    country_code: 'ca',
  },
  boundingbox: ['47.0021', '48.9873', '-74.5041', '-72.4118'],
};

/** Mid-ocean / unmappable point: Nominatim returns HTTP 200 with an error body. */
const ERROR_FIXTURE = { error: 'Unable to geocode' };

describe('pickNominatimName', () => {
  it('picks the town for a settlement hit', () => {
    expect(pickNominatimName(TOWN_FIXTURE)).toBe('Sainte-Adèle');
  });

  it('prefers village over town/city when several settlement keys are present', () => {
    const payload = {
      ...TOWN_FIXTURE,
      address: { village: 'Val-David', town: 'Sainte-Agathe-des-Monts', city: 'Montréal' },
    };
    expect(pickNominatimName(payload)).toBe('Val-David');
  });

  it('prefers a named natural feature (lake) over the surrounding settlement', () => {
    expect(pickNominatimName(LAKE_FIXTURE)).toBe('Lac Tremblant');
  });

  it('also accepts the v1 `class` field for natural features', () => {
    const v1 = { ...LAKE_FIXTURE, category: undefined, class: 'natural' };
    expect(pickNominatimName(v1)).toBe('Lac Tremblant');
  });

  it('ignores an unnamed natural feature and falls through to the address', () => {
    const unnamedPond = { ...LAKE_FIXTURE, name: '' };
    expect(pickNominatimName(unnamedPond)).toBe('Mont-Tremblant');
  });

  it('falls back to the county when no settlement is nearby', () => {
    expect(pickNominatimName(BACKCOUNTRY_FIXTURE)).toBe('Le Domaine-du-Roy');
  });

  it('falls back to the state when only the state resolves', () => {
    const remote = { ...BACKCOUNTRY_FIXTURE, address: { state: 'Québec', country: 'Canada' } };
    expect(pickNominatimName(remote)).toBe('Québec');
  });

  it('returns null for the Nominatim error payload', () => {
    expect(pickNominatimName(ERROR_FIXTURE)).toBeNull();
  });

  it('returns null for junk payloads', () => {
    expect(pickNominatimName(null)).toBeNull();
    expect(pickNominatimName(undefined)).toBeNull();
    expect(pickNominatimName('Unable to geocode')).toBeNull();
    expect(pickNominatimName(42)).toBeNull();
    expect(pickNominatimName({})).toBeNull();
    expect(pickNominatimName({ address: null })).toBeNull();
    expect(pickNominatimName({ address: { postcode: 'J8E 1T1' } })).toBeNull();
  });

  it('trims whitespace around the picked name', () => {
    expect(pickNominatimName({ address: { village: '  Val-Morin  ' } })).toBe('Val-Morin');
  });
});

describe('dedupeLabel', () => {
  it('returns the name unchanged when nothing clashes', () => {
    expect(dedupeLabel('Sainte-Adèle', [])).toBe('Sainte-Adèle');
    expect(dedupeLabel('Sainte-Adèle', ['Mont-Tremblant'])).toBe('Sainte-Adèle');
  });

  it('suffixes " 2" on the first clash', () => {
    expect(dedupeLabel('Sainte-Adèle', ['Sainte-Adèle'])).toBe('Sainte-Adèle 2');
  });

  it('finds the next free number when several are taken', () => {
    expect(dedupeLabel('Sainte-Adèle', ['Sainte-Adèle', 'Sainte-Adèle 2', 'Sainte-Adèle 3'])).toBe(
      'Sainte-Adèle 4',
    );
  });

  it('fills gaps in the numbering', () => {
    expect(dedupeLabel('Sainte-Adèle', ['Sainte-Adèle', 'Sainte-Adèle 3'])).toBe('Sainte-Adèle 2');
  });

  it('compares case-insensitively', () => {
    expect(dedupeLabel('Sainte-Adèle', ['sainte-adèle'])).toBe('Sainte-Adèle 2');
  });

  it('ignores surrounding whitespace on both sides', () => {
    expect(dedupeLabel('  Val-David ', ['Val-David'])).toBe('Val-David 2');
    expect(dedupeLabel('Val-David', [' val-david  '])).toBe('Val-David 2');
  });

  it('handles duplicate entries in the existing list', () => {
    expect(dedupeLabel('Offline map', ['Offline map', 'Offline map'])).toBe('Offline map 2');
  });
});
