import fixtures from './__fixtures__/stations.json';
import { parseLevels, parseTideStation, pickTappedStation, stationKey } from './station';

describe('parseTideStation (tiles written by infra/tiles/nas/tides/build.py)', () => {
  it('decodes The Battery verbatim', () => {
    const s = parseTideStation(fixtures.battery);
    expect(s).not.toBeNull();
    if (!s) return;
    expect(stationKey(s)).toBe('0:8518750');
    expect(s).toMatchObject({
      name: 'THE BATTERY',
      kind: 'gauge',
      live: 'coops',
      cdKind: 'mllw',
      epoch: '1983–2001',
      national: [{ datum: 'NAVD88', text: '-0.846' }],
    });
    expect(s.levels[0]).toEqual({ code: 'HAT', text: '1.976' });
    expect(s.levels.find((l) => l.code === 'MLLW')?.text).toBe('0.000');
    expect(s.extremes).toEqual([
      { code: 'HOWL', text: '4.280', date: '2012-10-30' },
      { code: 'LOWL', text: '-1.307', date: '1976-02-02' },
    ]);
    expect(s.ellipsoid).toEqual({
      text: '-32.77',
      frame: 'NAD83(2011)',
      epoch: '2010.0',
      how: 'derived',
      checkedBy: 'NOAA VDatum',
      deltaM: 0.009,
      basis: 'CO-OPS NAVD88 offset + NGS GEOID18',
    });
  });

  it('keeps no ellipsoid when the build had no oracle agreement', () => {
    expect(parseTideStation(fixtures.bergen_no_ellipsoid)?.ellipsoid).toBeUndefined();
  });

  it('reads the reference port and the published position accuracy', () => {
    const sec = parseTideStation(fixtures.secondary_with_reference_port);
    expect(sec?.refPort?.name).toBe('THE BATTERY');
    expect(sec?.refPort?.levels.some((l) => l.code === 'LAT')).toBe(true);
    expect(parseTideStation(fixtures.wakkanai)?.posAccM).toBe(1000);
  });

  it('rejects malformed features and values, never guessing', () => {
    expect(parseTideStation(null)).toBeNull();
    expect(parseTideStation({ i: 'x', s: 0, n: 'x' })).toBeNull(); // no CD kind
    expect(parseTideStation({ ...fixtures.battery, y: 120 })).toBeNull();
    expect(parseLevels('HAT=1.9;BAD;MSL=abc;LAT=-0.4@1999-01-01;X=1@soon')).toEqual([
      { code: 'HAT', text: '1.9' },
      { code: 'LAT', text: '-0.4', date: '1999-01-01' },
      { code: 'X', text: '1' },
    ]);
    const broken = parseTideStation({
      ...fixtures.battery,
      E: '-32.77|NAD83(2011)||guessed|x|0|y',
    });
    expect(broken?.ellipsoid).toBeUndefined();
    expect(parseTideStation({ ...fixtures.battery, k: 'other' })?.kind).toBe('hist');
  });

  it('falls back on the geometry position', () => {
    const { y: _y, x: _x, ...rest } = fixtures.battery;
    expect(parseTideStation(rest, [-74, 40.7])).toMatchObject({ lat: 40.7, lng: -74 });
  });
});

describe('pickTappedStation', () => {
  it('takes the nearest station in the hit box', () => {
    const f = (props: Record<string, unknown>, lng: number, lat: number) => ({
      properties: props,
      geometry: { type: 'Point', coordinates: [lng, lat] },
    });
    const a = f({ ...fixtures.battery, x: -74.0, y: 40.7 }, -74.0, 40.7);
    const b = f({ ...fixtures.brest, x: -74.01, y: 40.7 }, -74.01, 40.7);
    expect(pickTappedStation([a, b, 'junk', null], [-74.009, 40.7])?.name).toBe('Brest');
    expect(pickTappedStation([], [0, 0])).toBeNull();
  });
});
