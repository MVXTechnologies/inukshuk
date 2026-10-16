/**
 * The tide card opens on its graph (#764): observed past solid, predicted
 * dashed, now, the next high and low; the tide now under it; the levels
 * table next. "Not for navigation" only where a licence asks for it (CHS).
 */
import type { TideSeries } from '@core/tides/levels';
import { parseTideStation, type TideStation } from '@core/tides/station';
import { useSettingsStore } from '@state/settingsStore';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { darkTheme, lightTheme } from '@ui/theme';
import { PaperProvider } from 'react-native-paper';

import fixtures from '../../../core/tides/__fixtures__/stations.json';
import { TideStationCard } from './TideStationCard';

const mockLoad = jest.fn();
const mockCached = jest.fn();
jest.mock('@data/tideSeries', () => ({
  loadTideSeries: (...a: unknown[]) => mockLoad(...a),
  cachedTideSeries: (...a: unknown[]) => mockCached(...a),
}));

const H = 3_600_000;
const NOW = Date.now();
const tide = (t: number) => 1.6 + 1.35 * Math.cos((2 * Math.PI * (t / H - 3.57)) / 12.42);
function series(fromH: number, toH: number, stepMin: number) {
  const out = [];
  for (let t = fromH * H; t <= toH * H; t += stepMin * 60_000) {
    out.push({ timeMs: NOW + t, heightM: tide(t) });
  }
  return out;
}
const LIVE: TideSeries = {
  observed: series(-12, 0, 6),
  predicted: series(-12, 48, 30),
  extremes: [
    { timeMs: NOW + 3.57 * H, heightM: 2.95, kind: 'high' },
    { timeMs: NOW + 9.78 * H, heightM: 0.25, kind: 'low' },
  ],
};

function station(props: Record<string, unknown>): TideStation {
  const s = parseTideStation(props);
  if (!s) throw new Error('fixture');
  return s;
}
const BATTERY = station(fixtures.battery);
const BREST = station(fixtures.brest);
const REF = station({ ...fixtures.battery, k: 'ref', lv: undefined });

async function show(s: TideStation, dark = false) {
  await render(
    <PaperProvider theme={dark ? darkTheme : lightTheme}>
      <TideStationCard
        station={s}
        onOpenLink={jest.fn()}
        onNavigate={jest.fn()}
        onCopy={jest.fn()}
        onClose={jest.fn()}
      />
    </PaperProvider>,
  );
  // Let the series land, then give the graph its width.
  await act(async () => {});
  const graph = screen.queryByTestId('tide-graph');
  if (graph) {
    await act(async () => {
      fireEvent(graph, 'layout', { nativeEvent: { layout: { width: 328, height: 128 } } });
    });
  }
}

beforeEach(() => {
  mockLoad.mockReset();
  mockCached.mockReset().mockReturnValue(null);
  useSettingsStore.setState({ units: { distance: 'km', elevation: 'm' } });
});

describe('TideStationCard: the graph first', () => {
  it.each([false, true])(
    'a live gauge opens on its graph, then the tide now, then the table (dark %s)',
    async (dark) => {
      mockLoad.mockResolvedValue({ series: LIVE, fromCache: false });
      await show(BATTERY, dark);
      const graph = screen.getByTestId('tide-graph');
      expect(graph.props.accessibilityLabel).toMatch(
        /^Tide graph, m above MLLW\. High \d\d:\d\d · 2\.95\. Low \d\d:\d\d · 0\.25$/,
      );
      const now = screen.getByTestId('tide-now');
      expect(screen.getByText(`${tide(0).toFixed(2)} m`)).toBeTruthy();
      expect(screen.getByText(/^\+0\.\d\d m\/h$/)).toBeTruthy();
      expect(screen.getByText('observed')).toBeTruthy();
      expect(screen.getByText('predicted')).toBeTruthy();
      // Order: graph → now → levels table → position.
      const order = ['tide-graph', 'tide-now', 'tide-levels', 'tide-copy-position'].map((id) =>
        JSON.stringify(screen.toJSON()).indexOf(`"testID":"${id}"`),
      );
      expect(order.every((i) => i >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(now).toBeTruthy();
    },
  );

  it('the kind is in the subtitle; no chips, no navigation notice for NOAA', async () => {
    mockLoad.mockResolvedValue({ series: LIVE, fromCache: false });
    await show(BATTERY);
    expect(screen.getByText('8518750 · NOAA CO-OPS · Live gauge')).toBeTruthy();
    expect(screen.queryByText(/navigation/i)).toBeNull();
    expect(screen.queryByText('Tide station')).toBeNull();
  });

  it('a predictions-only station: the dashed curve, "predicted", no observed key', async () => {
    mockLoad.mockResolvedValue({ series: { ...LIVE, observed: [] }, fromCache: false });
    await show(REF);
    expect(screen.getByTestId('tide-graph')).toBeTruthy();
    expect(screen.getAllByText('predicted')).toHaveLength(2);
    expect(screen.queryByText('observed')).toBeNull();
  });

  it('an old reading: faded with its age, and the predicted level now', async () => {
    mockLoad.mockResolvedValue({
      series: { ...LIVE, observed: series(-12, -2, 6) },
      fromCache: true,
    });
    await show(BATTERY);
    expect(screen.getByText(/^at \d\d:\d\d · 2 h ago$/)).toBeTruthy();
    expect(screen.getByText(/^now ≈ \d\.\d\d m$/)).toBeTruthy();
  });

  it('shows the device copy while the request runs', async () => {
    mockCached.mockReturnValue({ series: LIVE, fromCache: true });
    mockLoad.mockReturnValue(new Promise(() => undefined));
    await show(BATTERY);
    expect(screen.getByTestId('tide-graph')).toBeTruthy();
  });

  it('loading, then offline with nothing saved: one line each', async () => {
    let fail: (e: Error) => void = () => undefined;
    mockLoad.mockReturnValue(new Promise((_r, reject) => (fail = reject)));
    await show(BATTERY);
    expect(screen.getByText('Reading the tide…')).toBeTruthy();
    await act(async () => fail(new Error('offline')));
    expect(screen.getByText('Needs a connection.')).toBeTruthy();
  });

  it('feet: the tide now in the unit setting', async () => {
    useSettingsStore.setState({ units: { distance: 'mi', elevation: 'ft' } });
    mockLoad.mockResolvedValue({ series: LIVE, fromCache: false });
    await show(BATTERY);
    expect(screen.getByText(/^\d\.\d\d ft$/)).toBeTruthy();
    expect(screen.getByTestId('tide-graph').props.accessibilityLabel).toMatch(/ft above MLLW/);
  });

  it('a station without a feed (SHOM): no graph, the table first, nothing asked', async () => {
    await show(BREST);
    expect(screen.queryByTestId('tide-graph')).toBeNull();
    expect(screen.queryByTestId('tide-graph-state')).toBeNull();
    expect(screen.getByTestId('tide-levels')).toBeTruthy();
    expect(mockLoad).not.toHaveBeenCalled();
  });
});
