import { featureFilter } from '@maplibre/maplibre-gl-style-spec';
import { buildGeodeticCard } from '@core/geodetic/card';
import {
  activeFilterCount,
  buildGeodeticFilters,
  DEFAULT_GEODETIC_FILTER,
  sanitizeGeodeticFilter,
  type GeodeticFilter,
} from '@core/geodetic/filter';
import { parseGeodeticFeature } from '@core/geodetic/record';
import { buildTidalLabelLayer, parseTidalHeight, tidalCardRow, tidalIcon } from './tidalBenchmark';

// KV0584 (Battery NO 3): NGS NAVD88 3.431; CO-OPS sheet MLLW 4.277 / MHW 2.834 (2012-11-20).
const KV0584 = {
  i: 'KV0584',
  s: 2,
  k: 'v',
  y: 40.70372778,
  x: -74.01649722,
  d: 4,
  n: '851 8750 TIDAL 3',
  H: '3.431',
  hd: 2,
  cd: '4.277',
  cs: 'us-coops:8518750',
  cN: 'THE BATTERY',
  cn: 'mllw',
  cdt: '2012-11-20',
  cm: '2.834',
};

describe('tidal benchmarks in the geodetic layer', () => {
  it('parses the tidal keys verbatim', () => {
    expect(parseTidalHeight(KV0584)).toEqual({
      cd: '4.277',
      station: 'us-coops:8518750',
      stationName: 'THE BATTERY',
      cdKind: 'mllw',
      date: '2012-11-20',
      mhw: '2.834',
    });
    expect(parseTidalHeight({ ...KV0584, cd: 'n/a' })).toBeUndefined();
    expect(parseTidalHeight({ i: 'X' })).toBeUndefined();
    expect(parseTidalHeight({ ...KV0584, cu: 1 })?.unchecked).toBe(true);
  });

  it('gives the mark a Chart datum row of its own, apart from the levelled height', () => {
    const mark = parseGeodeticFeature(KV0584);
    expect(mark?.tidal?.cd).toBe('4.277');
    const card = buildGeodeticCard(mark!);
    const tidal = card.rows.find((r) => r.key === 'tidal');
    const heights = card.rows.find((r) => r.key === 'heights');
    expect(tidal?.lines[0]).toMatchObject({
      text: '4.277 m above MLLW',
      note: 'CD of THE BATTERY (8518750)',
      copy: 'CD height = 4.277 m above MLLW (THE BATTERY 8518750, NOAA CO-OPS 2012-11-20)',
    });
    expect(tidal?.lines[1]?.copy).toBe('2.834 m above MHW (THE BATTERY 8518750)');
    // The orthometric row stays NGS's own levelled value — never a CD-derived one.
    expect(heights?.lines[0]?.text).toBe('3.431 m');
    expect(card.rows.findIndex((r) => r.key === 'tidal')).toBeLessThan(
      card.rows.findIndex((r) => r.key === 'heights'),
    );
    expect(card.chips[0]).toEqual({ label: 'Tidal benchmark', tone: 'tidal' });
    expect(card.credit).toContain('NOAA/NOS/CO-OPS');
    expect(card.credit).toContain('Not for navigation');
  });

  it('says when the join could not be cross-checked', () => {
    const t = parseTidalHeight({ ...KV0584, cu: 1 });
    expect(tidalCardRow(t!).lines.at(-1)?.text).toContain('no levelled height to cross-check');
    expect(tidalCardRow(parseTidalHeight(KV0584)!).lines.at(-1)?.text).toContain(
      'agrees with the levelled height',
    );
  });

  it('has a plain property case for the icon and a z15 label', () => {
    expect(tidalIcon('dark', 'x')).toEqual(['case', ['has', 'cd'], 'geodetic-tbm-dark', 'x']);
    const l = buildTidalLabelLayer({
      theme: 'light',
      font: ['F'],
      source: 's',
      sourceLayer: 'geodetic',
    });
    expect(l).toMatchObject({ minzoom: 15, filter: ['has', 'cd'] });
    expect(JSON.stringify(l)).not.toContain('"zoom"');
  });
});

describe("the geodetic filter's Tidal chip", () => {
  const PLAIN_V = { i: 'KV0001', s: 2, k: 'v' };
  const marks = { tidalV: KV0584, plainV: PLAIN_V, gnss: { i: 'G', s: 2, k: 'gnss' } };
  function passing(f: Partial<GeodeticFilter>): string[] {
    const { official } = buildGeodeticFilters({ ...DEFAULT_GEODETIC_FILTER, ...f });
    if (official === null) return Object.keys(marks);
    const filter = featureFilter(official, 'filter');
    return Object.entries(marks)
      .filter(([, p]) => filter.filter({ zoom: 15 }, { type: 1, properties: p } as never))
      .map(([k]) => k);
  }

  it('is on by default and decides tidal benchmarks whatever their type', () => {
    expect(DEFAULT_GEODETIC_FILTER.tidal).toBe(true);
    expect(passing({ tidal: false })).toEqual(['plainV', 'gnss']);
    expect(passing({ types: ['gnss'] })).toEqual(['tidalV', 'gnss']);
    expect(passing({ types: [], tidal: true })).toEqual(['tidalV']);
    expect(passing({ types: [], tidal: false })).toEqual([]);
    expect(activeFilterCount({ ...DEFAULT_GEODETIC_FILTER, tidal: false })).toBe(1);
  });

  it('survives settings round-trips (absent = on)', () => {
    expect(sanitizeGeodeticFilter({}).tidal).toBe(true);
    expect(sanitizeGeodeticFilter({ tidal: false }).tidal).toBe(false);
    expect(sanitizeGeodeticFilter({ tidal: 'no' }).tidal).toBe(true);
  });
});
