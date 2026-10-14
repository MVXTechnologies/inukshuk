import { parseChsStationList } from '@core/tides/chs';
import type { LiveTide } from '@core/tides/live';
import { stationKey } from '@core/tides/station';

import { ref } from './presets';
import {
  liveStations,
  MAX_STRIP_STATIONS,
  nearbyStations,
  nearestStation,
  NEAREST_MAX_M,
  resolveStation,
  STATIONS_LISTED,
  stationCell,
  stripStationParams,
  tideSnapshot,
} from './tides';
import { NEAREST_STATION } from './types';

/** SYNTHETIC stations shaped like CHS IWLS /stations (names and ids made up). */
function chs(code: string, name: string, lat: number, lng: number, live: boolean) {
  return {
    id: `synth-${code}`,
    code,
    officialName: name,
    latitude: lat,
    longitude: lng,
    operating: live,
    timeSeries: live ? [{ code: 'wlo' }, { code: 'wlp-hilo' }] : [{ code: 'wlp-hilo' }],
  };
}

const LIST = parseChsStationList([
  chs('00001', 'Anse-Fictive', 46.8, -71.2, true),
  chs('00002', 'Port-Exemple', 46.82, -71.19, false),
  chs('00003', 'Cap-Imaginaire', 47.5, -70.0, true),
  chs('00004', 'Baie-Lointaine', 50.0, -66.0, true),
]);
const STATIONS = liveStations(LIST.features);
const HERE = { latitude: 46.81, longitude: -71.21 };

describe('liveStations', () => {
  it('keeps the stations with a live series only', () => {
    expect(STATIONS.map((s) => s.name)).toEqual([
      'Anse-Fictive',
      'Cap-Imaginaire',
      'Baie-Lointaine',
    ]);
    expect(STATIONS[0]!.live).toBe('chs');
  });

  it('skips what is not a station', () => {
    expect(liveStations([{ properties: { n: 'x' } }, { properties: null }, {}])).toEqual([]);
  });
});

describe('nearby and nearest', () => {
  it('lists nearest first, with distances, up to the limit', () => {
    const near = nearbyStations(STATIONS, HERE, 2);
    expect(near.map((n) => n.station.name)).toEqual(['Anse-Fictive', 'Cap-Imaginaire']);
    expect(near[0]!.distanceM).toBeLessThan(near[1]!.distanceM);
    // By default, the picker's length: all three here.
    expect(nearbyStations(STATIONS, HERE)).toHaveLength(3);
    expect(STATIONS_LISTED).toBe(20);
  });

  it('nearest within reach, else nothing', () => {
    expect(nearestStation(STATIONS, HERE)?.name).toBe('Anse-Fictive');
    expect(nearestStation(STATIONS, { latitude: 10, longitude: 10 })).toBeNull();
    expect(nearestStation([], HERE)).toBeNull();
    expect(NEAREST_MAX_M).toBe(100_000);
  });

  it('resolves a param: nearest from where you are, or the picked station by key', () => {
    expect(resolveStation(NEAREST_STATION, STATIONS, HERE)?.name).toBe('Anse-Fictive');
    expect(resolveStation(NEAREST_STATION, STATIONS, null)).toBeNull();
    const cap = STATIONS[1]!;
    expect(resolveStation(stationKey(cap), STATIONS, HERE)).toBe(cap);
    // A picked station needs no position.
    expect(resolveStation(stationKey(cap), STATIONS, null)).toBe(cap);
    expect(resolveStation('100:gone', STATIONS, HERE)).toBeNull();
  });

  it('the cell: a few metres of walking keep it, a kilometre changes it', () => {
    const a = stationCell(HERE);
    expect(stationCell({ latitude: 46.8101, longitude: -71.2101 })).toEqual(a);
    expect(stationCell({ latitude: 46.83, longitude: -71.21 })).not.toEqual(a);
  });
});

describe('stripStationParams', () => {
  it('the distinct stations the tide fields read, in strip order', () => {
    const rows = [
      [ref('tides:level'), ref('eta')],
      [ref('tides:nextHigh'), ref('tides:level', { station: '100:00003' })],
    ];
    expect(stripStationParams(rows)).toEqual([NEAREST_STATION, '100:00003']);
    expect(stripStationParams([[ref('eta')]])).toEqual([]);
  });

  it('an unnormalised param reads the nearest; capped', () => {
    const rows = [
      [{ field: 'tides:level', params: {} }],
      ['a', 'b', 'c', 'd'].map((s) => ref('tides:level', { station: s })),
    ];
    const out = stripStationParams(rows);
    expect(out[0]).toBe(NEAREST_STATION);
    expect(out).toHaveLength(MAX_STRIP_STATIONS);
  });
});

describe('tideSnapshot', () => {
  const station = STATIONS[0]!;
  const LIVE: LiveTide = {
    level: { heightM: 3.84, timeMs: 1 },
    trend: 'rising',
    nextHigh: { timeMs: 5000, heightM: 5.1, kind: 'high' },
    nextLow: null,
  };

  it('the live answer as the strip reads it', () => {
    expect(tideSnapshot(station, LIVE)).toEqual({
      stationName: 'Anse-Fictive',
      levelM: 3.84,
      trend: 'rising',
      nextHigh: { atMs: 5000, levelM: 5.1 },
    });
  });

  it('a stale level keeps the next high; nothing at all is nothing', () => {
    expect(tideSnapshot(station, { ...LIVE, level: null })?.levelM).toBeNull();
    expect(tideSnapshot(station, { ...LIVE, nextHigh: null })?.nextHigh).toBeNull();
    expect(tideSnapshot(station, { ...LIVE, level: null, nextHigh: null })).toBeNull();
  });
});
