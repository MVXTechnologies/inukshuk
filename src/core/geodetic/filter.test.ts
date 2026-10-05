import { createExpression, featureFilter } from '@maplibre/maplibre-gl-style-spec';
import { GEODETIC_CATALOG, OSM_SOURCE_INDEX } from './catalog';
import {
  activeFilterCount,
  buildGeodeticFilters,
  DEFAULT_GEODETIC_FILTER,
  sanitizeGeodeticFilter,
  type GeodeticFilter,
} from './filter';

const src = (key: string) => GEODETIC_CATALOG.sources.findIndex((s) => s.key === key);
const vd = (name: string) => GEODETIC_CATALOG.vdatums.findIndex((v) => v.name === name);
const QC = src('qc-mrnf');
const NGS = src('us-ngs');

/** Real tile records (as `infra/tiles/nas/geodetic/tiles.py` writes them). */
const SHEET = {
  i: 'M15KM007',
  s: QC,
  k: '3d',
  d: 0,
  H: '51.158',
  hd: vd('CGVD2013'),
  H2: '51.54',
  hd2: vd('CGVD28'),
  h: '23.393',
  gc: 'x',
  g1: 'UTM zone 19N;1;2',
  v: '2018-04-26',
};
const BULK = { i: '22298', s: QC, k: 'h', d: 0, p: 20 };
const OLD_BM = { i: 'PG0223', s: NGS, k: 'v', l: 1, c: 1, p: 300, H: '30.', hd: vd('NAVD88') };
const UNKNOWN = { i: 'X', s: NGS, k: 'gnss', c: 4 };
const MARKS = { SHEET, BULK, OLD_BM, UNKNOWN };

/** Which of MARKS pass a filter (evaluated by MapLibre's own reference engine). */
function passing(f: Partial<GeodeticFilter>): string[] {
  const { official } = buildGeodeticFilters({ ...DEFAULT_GEODETIC_FILTER, ...f });
  if (official === null) return Object.keys(MARKS);
  const filter = featureFilter(official, 'filter');
  return Object.entries(MARKS)
    .filter(([, p]) => filter.filter({ zoom: 14 }, { type: 1, properties: p } as never))
    .map(([k]) => k);
}

describe('geodetic filter', () => {
  it('filters nothing by default', () => {
    expect(buildGeodeticFilters(DEFAULT_GEODETIC_FILTER)).toEqual({ official: null, osm: null });
    expect(activeFilterCount(DEFAULT_GEODETIC_FILTER)).toBe(0);
  });

  it('by type', () => {
    expect(passing({ types: ['v', 'gnss'] })).toEqual(['OLD_BM', 'UNKNOWN']);
    expect(passing({ types: [] })).toEqual([]);
  });

  it('by datum model', () => {
    expect(passing({ datum: 'legacy' })).toEqual(['OLD_BM']);
    expect(passing({ datum: 'modern' })).toEqual(['SHEET', 'BULK', 'UNKNOWN']);
  });

  it('by condition (good / to verify / unknown)', () => {
    expect(passing({ status: ['ok'] })).toEqual(['SHEET', 'BULK']);
    expect(passing({ status: ['damaged', 'unknown'] })).toEqual(['OLD_BM', 'UNKNOWN']);
  });

  it('by position precision', () => {
    expect(passing({ precision: '10' })).toEqual(['SHEET', 'BULK', 'UNKNOWN']);
    expect(passing({ precision: '2' })).toEqual(['SHEET', 'BULK', 'UNKNOWN']);
    expect(passing({ precision: '1' })).toEqual(['SHEET', 'UNKNOWN']);
  });

  it('by heights, datasheet details and last visit', () => {
    expect(passing({ hasHeights: true })).toEqual(['SHEET', 'OLD_BM']);
    expect(passing({ hasDetails: true })).toEqual(['SHEET']);
    expect(passing({ visitedSince: 2018 })).toEqual(['SHEET']);
    expect(passing({ visitedSince: 2019 })).toEqual([]);
  });

  it('by vertical datum (any of), on the first or the second height', () => {
    expect(passing({ vdatums: [vd('CGVD28')] })).toEqual(['SHEET']);
    expect(passing({ vdatums: [vd('NAVD88'), vd('CGVD2013')] })).toEqual(['SHEET', 'OLD_BM']);
  });

  it('by source', () => {
    expect(passing({ hiddenSources: [NGS] })).toEqual(['SHEET', 'BULK']);
  });

  it('combines groups (all must hold) and counts them for the badge', () => {
    const f = { ...DEFAULT_GEODETIC_FILTER, types: ['v' as const], hasHeights: true };
    expect(passing(f)).toEqual(['OLD_BM']);
    expect(activeFilterCount(f)).toBe(2);
  });

  it('hides OSM points on attributes they lack, filters them on the ones they have', () => {
    expect(buildGeodeticFilters({ ...DEFAULT_GEODETIC_FILTER, datum: 'modern' }).osm).toBe(
      'hidden',
    );
    expect(
      buildGeodeticFilters({ ...DEFAULT_GEODETIC_FILTER, hiddenSources: [OSM_SOURCE_INDEX] }).osm,
    ).toBe('hidden');
    expect(buildGeodeticFilters({ ...DEFAULT_GEODETIC_FILTER, hasHeights: true }).osm).toEqual([
      'has',
      'H',
    ]);
  });

  it('every expression compiles under the MapLibre spec, with no zoom in it', () => {
    const everything: GeodeticFilter = {
      types: ['3d'],
      datum: 'modern',
      status: ['ok'],
      precision: '2',
      hasHeights: true,
      hasDetails: true,
      visitedSince: 2010,
      vdatums: [0, 1],
      hiddenSources: [NGS],
    };
    const { official } = buildGeodeticFilters(everything);
    expect(JSON.stringify(official)).not.toContain('zoom');
    const compiled = createExpression(official, {
      type: 'boolean',
      'property-type': 'data-driven',
      expression: { interpolated: false, parameters: ['zoom', 'feature'] },
    } as never);
    expect(compiled.result).toBe('success');
  });

  it('sanitizes whatever settings.json holds', () => {
    expect(sanitizeGeodeticFilter(null)).toEqual(DEFAULT_GEODETIC_FILTER);
    expect(
      sanitizeGeodeticFilter({
        types: ['v', 'bogus'],
        datum: 'weird',
        status: 'ok',
        precision: '2',
        hasHeights: 'yes',
        visitedSince: 3.5,
        vdatums: [1, 1, -2, 9999],
        hiddenSources: [NGS],
        extra: 1,
      }),
    ).toEqual({
      ...DEFAULT_GEODETIC_FILTER,
      types: ['v'],
      precision: '2',
      vdatums: [1],
      hiddenSources: [NGS],
    });
  });
});
