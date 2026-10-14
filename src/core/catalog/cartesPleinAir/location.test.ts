import type { CpaRiver } from './listing';
import {
  geonamesQueryUrl,
  isoRegion,
  mapLocation,
  matchGeoname,
  normalizeName,
  parseGeonames,
  PROVINCE_BBOX,
  QC_REGION_BBOX,
  regionLocation,
  regionsBbox,
  roundBbox,
  siteRiverName,
  splitHydronym,
  unionBbox,
  type GeonameCandidate,
} from './location';

const river = (name: string, regions: string[]): CpaRiver => ({ id: 'r', name, regions });

/** A CGNDB row as the geonames.json API returns it (trimmed). */
function geoname(
  name: string,
  lat: number,
  lon: number,
  extra: { id?: string; status?: string; concise?: string; bbox?: number[] } = {},
) {
  return {
    id: 'X',
    name,
    feature: { id: extra.id ?? `f-${name}-${lat}` },
    status: { code: extra.status ?? 'official' },
    concise: { code: extra.concise ?? 'RIV' },
    latitude: lat,
    longitude: lon,
    ...(extra.bbox !== undefined ? { bbox: extra.bbox } : {}),
  };
}

describe('regions', () => {
  it('covers all 17 Québec regions with sane boxes', () => {
    const codes = Object.keys(QC_REGION_BBOX);
    expect(codes).toHaveLength(17);
    for (const [w, s, e, n] of Object.values(QC_REGION_BBOX)) {
      expect(w).toBeLessThan(e);
      expect(s).toBeLessThan(n);
      // Inside Québec's own envelope.
      const [qw, qs, qe, qn] = PROVINCE_BBOX['ca:qc'] ?? [0, 0, 0, 0];
      expect(w).toBeGreaterThanOrEqual(qw);
      expect(e).toBeLessThanOrEqual(qe);
      expect(s).toBeGreaterThanOrEqual(qs);
      expect(n).toBeLessThanOrEqual(qn);
    }
  });

  it('unions the Québec regions, ignoring a neighbouring province beside them', () => {
    expect(regionsBbox(['qc:07'])).toEqual(QC_REGION_BBOX['qc:07']);
    expect(regionsBbox(['qc:07', 'ca:on'])).toEqual(QC_REGION_BBOX['qc:07']);
    expect(regionsBbox(['qc:06', 'qc:13'])).toEqual([-74.0, 45.39, -73.47, 45.71]);
    expect(regionsBbox(['ca:on'])).toEqual(PROVINCE_BBOX['ca:on']);
    expect(regionsBbox(['xx:1'])).toBeNull();
    expect(regionsBbox([])).toBeNull();
    expect(unionBbox([])).toBeNull();
  });

  it('maps region codes to ISO 3166-2', () => {
    expect(isoRegion(['qc:07', 'ca:on'])).toBe('CA-QC');
    expect(isoRegion(['ca:nl'])).toBe('CA-NL');
    expect(isoRegion(['zz'])).toBeUndefined();
    expect(isoRegion([])).toBeUndefined();
  });

  it('falls back to the regions, labelled as such', () => {
    expect(regionLocation(['qc:07'])).toEqual({
      bbox: QC_REGION_BBOX['qc:07'],
      precision: 'region',
      evidence: 'administrative regions qc:07',
    });
    expect(regionLocation(['xx'])).toBeNull();
  });
});

describe('names', () => {
  it('normalises accents, apostrophes and hyphens', () => {
    expect(normalizeName('Rivière à l’Eau-Chaude')).toBe('riviere a l eau chaude');
    expect(normalizeName('  Lac  du Poisson—Blanc (x) ')).toBe('lac du poisson blanc x');
  });

  it('splits a hydronym into generic and specific', () => {
    expect(splitHydronym('Rivière du Nord')).toEqual({ generic: 'riviere', specific: 'nord' });
    expect(splitHydronym('Ruisseau à l’Eau Chaude')).toEqual({
      generic: 'ruisseau',
      specific: 'eau chaude',
    });
    expect(splitHydronym('Palmer River')).toEqual({ generic: 'river', specific: 'palmer' });
    expect(splitHydronym('Belle Rivière')).toEqual({ generic: 'none', specific: 'belle riviere' });
    expect(splitHydronym('Bras d’Henri')).toEqual({ generic: 'bras', specific: 'henri' });
  });

  it('reads the site’s names: parenthesised hints and disambiguators', () => {
    expect(siteRiverName('Désert')).toEqual({
      query: 'Désert',
      generic: 'none',
      specific: 'desert',
    });
    expect(siteRiverName('Du Nord (Dumoine)')).toEqual({
      query: 'Du Nord',
      generic: 'none',
      specific: 'nord',
    });
    expect(siteRiverName('Bryson (ruisseau)')).toMatchObject({ generic: 'ruisseau' });
    expect(siteRiverName('Saint-Laurent (fleuve)')).toMatchObject({
      generic: 'fleuve',
      specific: 'saint laurent',
    });
    expect(siteRiverName('Lac du Poisson blanc')).toMatchObject({ generic: 'lac' });
    expect(siteRiverName('(sans nom) (René-Lévesque)')).toBeNull();
    expect(siteRiverName('Rivière')).toBeNull();
  });
});

describe('geonamesQueryUrl', () => {
  it('asks for the bare name, the province and the feature type', () => {
    expect(geonamesQueryUrl(river('Rimouski', ['ca:nb', 'qc:01']))).toBe(
      'https://geogratis.gc.ca/services/geoname/en/geonames.json?q=Rimouski&province=24&concise=RIV&num=100',
    );
    expect(geonamesQueryUrl(river('Lac du Poisson blanc', ['qc:07']))).toContain('concise=LAKE');
    expect(geonamesQueryUrl(river('Chenal Bostonnais', ['qc:04']))).not.toContain('concise=');
    expect(geonamesQueryUrl(river('Petawawa', ['ca:on']))).toContain('province=35');
    expect(geonamesQueryUrl(river('Palmer (Labrador)', ['ca:nl']))).toContain('province=10');
    expect(geonamesQueryUrl(river('(sans nom)', ['qc:09']))).toBeNull();
  });
});

describe('matchGeoname', () => {
  const desert = river('Désert', ['qc:07']);

  it('takes the one official feature with the same name in the regions', () => {
    const rows = parseGeonames({
      items: [
        geoname('Rivière du Grand Désert', 46.87, -71.37),
        geoname('Rivière Désert', 46.3856, -75.9742, {
          id: 'EGNTM',
          bbox: [-76.2369414, 46.3486461, -75.8725355, 46.7572992],
        }),
      ],
    });
    expect(matchGeoname(desert, rows)).toEqual({
      bbox: [-76.237, 46.3486, -75.8725, 46.7573],
      precision: 'river',
      evidence: 'CGNDB feature EGNTM "Rivière Désert"',
    });
  });

  it('ignores a town of the same name, and a river outside the regions', () => {
    const rows = parseGeonames({
      items: [
        geoname('Kipawa', 46.75, -79.05, { concise: 'MUN1' }),
        geoname('Rivière Kipawa', 47.05, -79.39, { id: 'K' }),
        geoname('Rivière Kipawa', 48.5, -70.0, { id: 'far' }),
      ],
    });
    expect(matchGeoname(river('Kipawa', ['qc:08']), rows)?.evidence).toContain('feature K ');
  });

  it('prefers the rivière to a ruisseau of the same name, then the official name', () => {
    const rows: GeonameCandidate[] = parseGeonames({
      items: [
        geoname('Ruisseau Saint-François', 45.47, -71.97, { id: 'brook' }),
        geoname('Rivière Saint-François', 46.12, -72.92, { id: 'river' }),
        geoname('Rivière Saint-François', 46.12, -72.92, { id: 'river', status: 'other' }),
      ],
    });
    const hit = matchGeoname(river('Saint-Francois', ['qc:05', 'qc:12', 'qc:17']), rows);
    expect(hit?.evidence).toContain('feature river ');

    const official = parseGeonames({
      items: [
        geoname('Rivière Clinton', 45.4, -70.9, { id: 'a', status: 'previouslyOfficial' }),
        geoname('Rivière Clinton', 45.41, -70.91, { id: 'b' }),
      ],
    });
    expect(matchGeoname(river('Clinton', ['qc:05']), official)?.evidence).toContain('feature b ');
  });

  it('honours the generic the site wrote', () => {
    const rows = parseGeonames({
      items: [
        geoname('Rivière Bryson', 45.7, -76.4, { id: 'riv' }),
        geoname('Ruisseau Bryson', 45.71, -76.41, { id: 'ru' }),
      ],
    });
    expect(matchGeoname(river('Bryson (ruisseau)', ['qc:07']), rows)?.evidence).toContain(
      'feature ru ',
    );
  });

  it('never guesses between two official rivers of the same name', () => {
    const rows = parseGeonames({
      items: [
        geoname('Rivière du Diable', 46.06, -74.63, { id: 'a' }),
        geoname('Rivière du Diable', 45.6, -73.82, { id: 'b' }),
      ],
    });
    expect(matchGeoname(river('Du Diable', ['qc:14', 'qc:15']), rows)).toBeNull();
  });

  it('gives a point-only feature a small box', () => {
    const rows = parseGeonames({
      items: [geoname('Ruisseau Pitchpine', 47.9, -74.7, { id: 'p' })],
    });
    expect(matchGeoname(river('Pitchpine (ruisseau)', ['qc:04']), rows)).toEqual({
      bbox: [-74.72, 47.88, -74.68, 47.92],
      precision: 'river',
      evidence: 'CGNDB feature p "Ruisseau Pitchpine" (point only)',
    });
  });

  it('cannot locate an unnamed river or one with unknown regions', () => {
    expect(matchGeoname(river('(sans nom)', ['qc:09']), [])).toBeNull();
    expect(matchGeoname(river('Désert', ['zz']), [])).toBeNull();
  });
});

describe('parseGeonames', () => {
  it('keeps well-formed rows and never throws', () => {
    expect(parseGeonames(null)).toEqual([]);
    expect(parseGeonames({ items: 'x' })).toEqual([]);
    const rows = parseGeonames({
      items: [
        null,
        { name: 'No feature', latitude: 1, longitude: 2 },
        { id: 'ID', name: 'Row id only', latitude: 1, longitude: 2, bbox: [3, 2, 1, 0] },
        { id: 'ID', name: 'No position' },
      ],
    });
    expect(rows).toEqual([{ featureId: 'ID', name: 'Row id only', latitude: 1, longitude: 2 }]);
  });
});

describe('mapLocation', () => {
  const a = { bbox: [-76, 46, -75.5, 46.5] as const, precision: 'river' as const, evidence: 'a' };
  const b = { bbox: [-75, 45.5, -74.5, 46] as const, precision: 'river' as const, evidence: 'b' };

  it('unions the rivers located by name', () => {
    expect(
      mapLocation([{ ...a, bbox: [...a.bbox] }, null, { ...b, bbox: [...b.bbox] }], ['qc:07']),
    ).toEqual({
      bbox: [-76, 45.5, -74.5, 46.5],
      precision: 'river',
      evidence: 'a; b',
    });
  });

  it('falls back to the regions when no river was located', () => {
    expect(mapLocation([null], ['qc:07'])?.precision).toBe('region');
    expect(mapLocation([], ['zz'])).toBeNull();
  });

  it('rounds outward', () => {
    expect(roundBbox([-76.23694, 46.34864, -75.87253, 46.75729])).toEqual([
      -76.237, 46.3486, -75.8725, 46.7573,
    ]);
  });
});
