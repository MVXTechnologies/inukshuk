/**
 * "Show levels on the map" (#764): the stations drawn on screen, the ones
 * worth a request at this zoom (live gauges only below z11, at most 12),
 * their labels; nothing while the setting is off or below z8.
 */
import type { TideSeries } from '@core/tides/levels';
import { useSettingsStore } from '@state/settingsStore';
import { act, renderHook } from '@testing-library/react-native';

import fixtures from '../../../core/tides/__fixtures__/stations.json';
import { LEVEL_QUERY_LAYERS, stationsOnScreen, useTideLevels } from './levels';

jest.mock('@maplibre/maplibre-react-native', () => ({
  GeoJSONSource: () => null,
  Layer: () => null,
  Images: () => null,
}));

const mockLoad = jest.fn();
jest.mock('@data/tideSeries', () => ({
  loadTideSeries: (...a: unknown[]) => mockLoad(...a),
}));

const NOW = Date.now();
const SERIES: TideSeries = {
  observed: [
    { timeMs: NOW - 20 * 60_000, heightM: 1.2 },
    { timeMs: NOW - 60_000, heightM: 1.36 },
  ],
  predicted: [],
  extremes: [{ timeMs: NOW + 3 * 3_600_000, heightM: 2.95, kind: 'high' }],
};

const feature = (props: Record<string, unknown>) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [props.x, props.y] },
  properties: props,
});
const GAUGE = feature(fixtures.battery);
const REF = feature({ ...fixtures.battery, i: '8518751', k: 'ref', lv: undefined });

beforeEach(() => {
  jest.useFakeTimers();
  mockLoad.mockReset().mockResolvedValue({ series: SERIES, fromCache: false });
  useSettingsStore.setState({ units: { distance: 'km', elevation: 'm' } });
});
afterEach(() => jest.useRealTimers());

async function run(zoom: number, on = true, offline = false) {
  const query = jest.fn(async () => [GAUGE, GAUGE, REF, { junk: true }, null]);
  const view = { zoom, center: [-74.01, 40.7] as const };
  const hook = await renderHook(() => useTideLevels(on, view, offline, query));
  await act(async () => {
    jest.advanceTimersByTime(700);
  });
  await act(async () => {});
  return { hook, query };
}

describe('useTideLevels', () => {
  it('z11+: every station with a feed on screen, once each', async () => {
    const { hook, query } = await run(12);
    expect(query).toHaveBeenCalledWith(LEVEL_QUERY_LAYERS);
    expect(mockLoad).toHaveBeenCalledTimes(2);
    const props = hook.result.current?.features.map((f) => f.properties);
    expect(props?.map((p) => p.k)).toEqual(['live', 'live']);
    expect(props?.[0]?.v2).toBe('1.36 m');
    expect(props?.[0]?.r1).toMatch(/^ · H \d\d:\d\d$/);
  });

  it('z8–10: live gauges only', async () => {
    await run(9);
    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(mockLoad.mock.calls[0]?.[0]).toMatchObject({ id: '8518750' });
  });

  it('nothing below z8 or while off: no query, no request', async () => {
    const low = await run(7);
    expect(low.query).not.toHaveBeenCalled();
    expect(low.hook.result.current).toBeNull();
    const off = await run(12, false);
    expect(off.query).not.toHaveBeenCalled();
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('offline: the device copy only (passed down), a failed station left out', async () => {
    mockLoad.mockImplementation(async (s: { id: string }) => {
      if (s.id === '8518751') throw new Error('offline');
      return { series: SERIES, fromCache: true };
    });
    const { hook } = await run(12, true, true);
    expect(mockLoad.mock.calls[0]?.[1]).toEqual({ offline: true });
    expect(hook.result.current?.features).toHaveLength(1);
  });

  it('refreshes every 10 min', async () => {
    const { query } = await run(12);
    await act(async () => {
      jest.advanceTimersByTime(10 * 60_000);
    });
    await act(async () => {
      jest.advanceTimersByTime(700);
    });
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('stationsOnScreen', () => {
  it('parses features once each and skips junk', () => {
    expect(stationsOnScreen([GAUGE, GAUGE, REF, 'x', { properties: {} }]).map((s) => s.id)).toEqual(
      ['8518750', '8518751'],
    );
  });
});
