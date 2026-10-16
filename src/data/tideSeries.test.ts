/**
 * The tide series' request budget (#764): observed every 10 min at most,
 * predictions once a day and kept on the device (offline labels and graph),
 * one request in flight per station, and nothing asked of a station without
 * a feed.
 */
import { LEVELS_REFRESH_MS, PREDICTION_TTL_MS } from '@core/tides/levels';
import { parseTideStation, type TideStation } from '@core/tides/station';

import { cachedTideSeries, loadTideSeries, resetTideSeriesForTests } from './tideSeries';

jest.mock('expo-file-system', () => {
  const files = new Map<string, string>();
  const path = (parts: (string | { uri: string })[]) =>
    parts.map((p) => (typeof p === 'string' ? p : p.uri)).join('/');
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = path(parts);
    }
    get exists() {
      return files.has(this.uri);
    }
    create() {
      files.set(this.uri, '');
    }
    write(text: string) {
      files.set(this.uri, text);
    }
    textSync() {
      return files.get(this.uri) ?? '';
    }
    delete() {
      files.delete(this.uri);
    }
  }
  class Directory {
    uri: string;
    exists = true;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = path(parts);
    }
    create() {}
  }
  return { File, Directory, Paths: { document: { uri: 'doc' } }, __files: files };
});
jest.mock('./chsStations', () => ({ chsGet: jest.fn(async () => []) }));

const files = (jest.requireMock('expo-file-system') as { __files: Map<string, string> }).__files;

function station(props: Record<string, unknown>): TideStation {
  const s = parseTideStation(props);
  if (!s) throw new Error('fixture');
  return s;
}
const GAUGE = station({
  i: '8443970',
  s: 0,
  n: 'Boston',
  k: 'gauge',
  cn: 'mllw',
  y: 42.35,
  x: -71.05,
  lv: 'coops',
});
const SECONDARY = station({
  i: '8444351',
  s: 0,
  n: 'Hull',
  k: 'sec',
  cn: 'mllw',
  y: 42.3,
  x: -70.9,
});
const SHOM = station({ i: 'BREST', s: 1, n: 'Brest', k: 'ref', cn: 'zh', y: 48.38, x: -4.49 });

const NOW = Date.UTC(2026, 9, 16, 17, 18);
const OBS = {
  data: [
    { t: '2026-10-16 17:12', v: '1.340' },
    { t: '2026-10-16 17:18', v: '1.360' },
  ],
};
const CURVE = {
  predictions: [
    { t: '2026-10-16 17:00', v: '1.20' },
    { t: '2026-10-16 17:30', v: '1.50' },
  ],
};
const HILO = {
  predictions: [
    { t: '2026-10-16 20:52', v: '2.95', type: 'H' },
    { t: '2026-10-17 03:05', v: '0.25', type: 'L' },
  ],
};

let fetchMock: jest.Mock;
beforeEach(() => {
  resetTideSeriesForTests();
  files.clear();
  fetchMock = jest.fn(async (url: string) => ({
    ok: true,
    json: async () =>
      url.includes('water_level') ? OBS : url.includes('interval=hilo') ? HILO : CURVE,
    text: async () => '',
  }));
  global.fetch = fetchMock as unknown as typeof fetch;
});

const calls = (part: string) =>
  fetchMock.mock.calls.filter(([u]) => String(u).includes(part)).length;

describe('loadTideSeries', () => {
  it('a live gauge: its observed series, predicted curve and highs/lows', async () => {
    const r = await loadTideSeries(GAUGE, { now: NOW });
    expect(r.fromCache).toBe(false);
    expect(r.series.observed.map((o) => o.heightM)).toEqual([1.34, 1.36]);
    expect(r.series.predicted).toHaveLength(2);
    expect(r.series.extremes.map((e) => e.kind)).toEqual(['high', 'low']);
    expect(calls('water_level')).toBe(1);
    expect(calls('interval=30')).toBe(1);
    expect(calls('interval=hilo')).toBe(1);
  });

  it('asks again for the gauge only after 10 min, for predictions only after a day', async () => {
    await loadTideSeries(GAUGE, { now: NOW });
    await loadTideSeries(GAUGE, { now: NOW + LEVELS_REFRESH_MS - 1 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await loadTideSeries(GAUGE, { now: NOW + LEVELS_REFRESH_MS });
    expect(calls('water_level')).toBe(2);
    expect(calls('interval=30')).toBe(1);
    await loadTideSeries(GAUGE, { now: NOW + PREDICTION_TTL_MS + 1 });
    expect(calls('interval=30')).toBe(2);
  });

  it('shares one request in flight per station', async () => {
    await Promise.all([loadTideSeries(GAUGE, { now: NOW }), loadTideSeries(GAUGE, { now: NOW })]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('a secondary station: highs and lows only, no gauge', async () => {
    const r = await loadTideSeries(SECONDARY, { now: NOW });
    expect(calls('interval=30')).toBe(0);
    expect(calls('water_level')).toBe(0);
    expect(r.series.extremes).toHaveLength(2);
  });

  it('a station without a feed asks nothing and has nothing', async () => {
    await expect(loadTideSeries(SHOM, { now: NOW })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps predictions on the device: offline still has them', async () => {
    await loadTideSeries(GAUGE, { now: NOW });
    resetTideSeriesForTests(); // a new session: memory gone, the file stays
    const offline = await loadTideSeries(GAUGE, { offline: true });
    expect(offline.fromCache).toBe(true);
    expect(offline.series.predicted).toHaveLength(2);
    expect(offline.series.observed).toEqual([]);
    expect(cachedTideSeries(GAUGE)?.series.extremes).toHaveLength(2);
    await expect(loadTideSeries(SECONDARY, { offline: true })).rejects.toThrow('offline');
  });

  it('a failed refresh keeps what it had and says so', async () => {
    await loadTideSeries(GAUGE, { now: NOW });
    fetchMock.mockRejectedValue(new Error('offline'));
    const r = await loadTideSeries(GAUGE, { now: NOW + LEVELS_REFRESH_MS });
    expect(r.fromCache).toBe(true);
    expect(r.series.observed).toHaveLength(2);
  });

  it('ignores a junk file on the device', () => {
    files.set('doc/tides/pred-0_8443970.json', '{"fetchedAt":"x"}');
    expect(cachedTideSeries(GAUGE)).toBeNull();
  });
});
