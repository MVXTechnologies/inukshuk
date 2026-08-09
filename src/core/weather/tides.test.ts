import type { LatLng } from '@core/models';
import hiloFixture from './__fixtures__/iwls-wlp-hilo.json';
import stationsFixture from './__fixtures__/iwls-stations.json';
import wloFixture from './__fixtures__/iwls-wlo.json';
import {
  currentLevel,
  nearestTideStation,
  nextHighLow,
  parseSeries,
  parseStations,
  stationDataUrl,
  stationsUrl,
  TIDE_LEVEL_MAX_AGE_MS,
  TIDE_MARINE_MAX_M,
  TIDE_NEARBY_MAX_M,
} from './tides';

// The fixtures are trimmed captures of the real IWLS API (2026-08-08):
// - iwls-stations.json — the 14 chs-region-code=QUE stations nearest Québec
//   City, incl. Vieux-Québec (operating, wlo+wlp+wlp-hilo), prediction-only
//   wharves (Lauzon, Immigration Wharf, ...) and dead entries with no series.
// - iwls-wlo.json — Vieux-Québec observed levels, 00:21–00:30 UTC.
// - iwls-wlp-hilo.json — Vieux-Québec high/low predictions over 36 h.
const QUEBEC_CITY: LatLng = { latitude: 46.8139, longitude: -71.208 };
const NOW_MS = Date.parse('2026-08-09T00:31:00Z');

describe('urls', () => {
  it('builds the region station-list url', () => {
    expect(stationsUrl()).toBe('https://api-iwls.dfo-mpo.gc.ca/api/v1/stations?chs-region-code=QUE');
    expect(stationsUrl('PAC')).toContain('chs-region-code=PAC');
  });

  it('builds a station data url with a millisecond-free ISO window', () => {
    const url = stationDataUrl('abc123', 'wlp-hilo', NOW_MS, NOW_MS + 3_600_000);
    expect(url).toBe(
      'https://api-iwls.dfo-mpo.gc.ca/api/v1/stations/abc123/data' +
        '?time-series-code=wlp-hilo&from=2026-08-09T00%3A31%3A00Z&to=2026-08-09T01%3A31%3A00Z',
    );
  });
});

describe('parseStations', () => {
  it('parses the real station list', () => {
    const stations = parseStations(stationsFixture);
    expect(stations).toHaveLength(14);
    const vq = stations.find((s) => s.code === '03248');
    expect(vq).toMatchObject({
      name: 'Vieux-Québec',
      operating: true,
      position: { latitude: 46.811111, longitude: -71.20175 },
    });
    expect(vq?.timeSeries).toEqual(
      expect.arrayContaining(['wlo', 'wlp', 'wlp-hilo', 'wlf-spine']),
    );
  });

  it('keeps stations with no series (they are filtered at selection, not parse)', () => {
    const stations = parseStations(stationsFixture);
    expect(stations.find((s) => s.code === '03253')?.timeSeries).toEqual([]);
  });

  it.each([
    ['not an array', { stations: [] }],
    ['null', null],
  ])('returns [] for %s', (_name, json) => {
    expect(parseStations(json)).toEqual([]);
  });

  it('drops entries missing id, name or coordinates', () => {
    const stations = parseStations([
      { id: 'ok', officialName: 'A', latitude: 1, longitude: 2 },
      { id: '', officialName: 'B', latitude: 1, longitude: 2 },
      { id: 'x', officialName: 'C', latitude: 'north', longitude: 2 },
      { id: 'y', latitude: 1, longitude: 2 },
      'junk',
    ]);
    expect(stations.map((s) => s.name)).toEqual(['A']);
  });
});

describe('nearestTideStation', () => {
  const stations = parseStations(stationsFixture);

  it('picks Vieux-Québec for a long-press in Québec City', () => {
    const near = nearestTideStation(stations, QUEBEC_CITY, TIDE_NEARBY_MAX_M);
    expect(near?.station.name).toBe('Vieux-Québec');
    expect(near?.distanceM).toBeGreaterThan(0);
    expect(near?.distanceM).toBeLessThan(2_000);
  });

  it('skips stations without wlp-hilo even when they are closer', () => {
    // Estuaire de la Rivière Saint-Charles (no series) is 1.4 km out but can
    // never feed the card; the pick must jump past it.
    const stCharles: LatLng = { latitude: 46.822, longitude: -71.225 };
    const near = nearestTideStation(stations, stCharles, TIDE_NEARBY_MAX_M);
    expect(near?.station.timeSeries).toContain('wlp-hilo');
  });

  it('returns null beyond the distance gate', () => {
    // ~71 km from the nearest predicting station (Saint-Nicolas): outside the
    // nearby gate, inside the marine-mode one.
    const inland: LatLng = { latitude: 46.6, longitude: -72.3 };
    expect(nearestTideStation(stations, inland, TIDE_NEARBY_MAX_M)).toBeNull();
    expect(nearestTideStation(stations, inland, TIDE_MARINE_MAX_M)).not.toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(nearestTideStation([], QUEBEC_CITY, TIDE_NEARBY_MAX_M)).toBeNull();
  });
});

describe('parseSeries', () => {
  it('parses observed readings sorted by time', () => {
    const series = parseSeries(wloFixture);
    expect(series).toHaveLength(10);
    expect(series[0]).toEqual({ timeMs: Date.parse('2026-08-09T00:21:00Z'), heightM: 1.148 });
    expect(series[9]).toEqual({ timeMs: Date.parse('2026-08-09T00:30:00Z'), heightM: 1.083 });
  });

  it('drops junk entries and sorts out-of-order input', () => {
    const series = parseSeries([
      { eventDate: '2026-08-09T02:00:00Z', value: 2 },
      { eventDate: '2026-08-09T01:00:00Z', value: 1 },
      { eventDate: 'yesterday-ish', value: 3 },
      { eventDate: '2026-08-09T03:00:00Z', value: 'high' },
      null,
      42,
    ]);
    expect(series.map((r) => r.heightM)).toEqual([1, 2]);
  });

  it('returns [] for non-array json', () => {
    expect(parseSeries({ data: [] })).toEqual([]);
  });
});

describe('currentLevel', () => {
  it('returns the reading closest to now from the real series', () => {
    const level = currentLevel(parseSeries(wloFixture), NOW_MS);
    expect(level).toEqual({ timeMs: Date.parse('2026-08-09T00:30:00Z'), heightM: 1.083 });
  });

  it('rejects a stale nearest reading', () => {
    const level = currentLevel(parseSeries(wloFixture), NOW_MS + TIDE_LEVEL_MAX_AGE_MS + 60_001);
    expect(level).toBeNull();
  });

  it('returns null for an empty series', () => {
    expect(currentLevel([], NOW_MS)).toBeNull();
  });
});

describe('nextHighLow', () => {
  const events = parseSeries(hiloFixture);

  it('classifies the real Vieux-Québec events (no kind flag in the API)', () => {
    const { nextHigh, nextLow } = nextHighLow(events, NOW_MS);
    expect(nextLow).toEqual({
      timeMs: Date.parse('2026-08-09T01:51:00Z'),
      heightM: 0.573,
      kind: 'low',
    });
    expect(nextHigh).toEqual({
      timeMs: Date.parse('2026-08-09T07:24:00Z'),
      heightM: 4.828,
      kind: 'high',
    });
  });

  it('skips past events — only upcoming tides count', () => {
    const afterFirstLow = Date.parse('2026-08-09T02:00:00Z');
    const { nextHigh, nextLow } = nextHighLow(events, afterFirstLow);
    expect(nextHigh?.timeMs).toBe(Date.parse('2026-08-09T07:24:00Z'));
    expect(nextLow?.timeMs).toBe(Date.parse('2026-08-09T15:27:00Z'));
  });

  it('classifies a last upcoming event against its previous neighbour', () => {
    const beforeLast = Date.parse('2026-08-10T04:00:00Z');
    const { nextHigh, nextLow } = nextHighLow(events, beforeLast);
    expect(nextHigh?.timeMs).toBe(Date.parse('2026-08-10T08:36:00Z'));
    expect(nextLow).toBeNull();
  });

  it('needs at least two events to tell high from low', () => {
    expect(nextHighLow([{ timeMs: NOW_MS + 1, heightM: 3 }], NOW_MS)).toEqual({
      nextHigh: null,
      nextLow: null,
    });
    expect(nextHighLow([], NOW_MS)).toEqual({ nextHigh: null, nextLow: null });
  });
});
