import type { TideStation } from '@core/tides/station';
import { CHS_SOURCE_INDEX } from '@core/tides/chs';
import { TIDE_CATALOG } from '@core/tides/catalog';
import { convertFromTideStation } from './entry';

function station(over: Partial<TideStation>): TideStation {
  return {
    id: '03248',
    source: CHS_SOURCE_INDEX,
    name: 'Vieux-Québec',
    lat: 46.8121,
    lng: -71.2022,
    kind: 'gauge',
    cdKind: 'cd-ca',
    levels: [],
    extremes: [],
    national: [{ datum: 'CGVD2013', text: '-2.340' }],
    flags: [],
    ...over,
  };
}

const sourceIndex = (key: string) => TIDE_CATALOG.sources.findIndex((s) => s.key === key);

describe('convertFromTideStation', () => {
  it('CHS station: chart datum with its CGVD2013 offset, CHS agency, Canada', () => {
    const req = convertFromTideStation(station({}));
    expect(req.origin).toEqual({
      kind: 'station',
      label: 'From station Vieux-Québec',
      id: '03248',
    });
    expect(req.notice).toBeUndefined();
    const st = req.stations?.[0];
    expect(st).toMatchObject({
      agency: 'CHS',
      country: 'ca',
      cdName: 'Chart datum',
      offsets: { cgvd2013: -2.34 },
    });
    expect(req.spec.fromHeight).toBe(`cd@${st?.key}`);
  });

  it('NOAA CO-OPS station: MLLW with its NAVD88 offset', () => {
    const req = convertFromTideStation(
      station({
        id: '8443970',
        source: sourceIndex('us-coops'),
        name: 'Boston',
        lat: 42.3539,
        lng: -71.0503,
        cdKind: 'mllw',
        national: [{ datum: 'NAVD88', text: '-1.709' }],
      }),
    );
    expect(req.stations?.[0]).toMatchObject({
      agency: 'NOAA CO-OPS',
      country: 'us',
      cdName: 'MLLW',
      offsets: { navd88: -1.709 },
    });
  });

  it('a station outside Canada and the US: no chart-datum prefill, a notice instead', () => {
    const req = convertFromTideStation(
      station({
        id: '35',
        source: sourceIndex('fr-shom'),
        name: 'Brest',
        lat: 48.38,
        lng: -4.49,
        cdKind: 'zh',
        national: [{ datum: 'IGN69', text: '-3.640' }],
      }),
    );
    expect(req.stations).toBeUndefined();
    expect(req.notice).toMatch(/no chart-datum offset/);
  });
});
