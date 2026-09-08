import { act, renderHook } from '@testing-library/react-native';
import type { GeoBbox } from '@core/geo/marineDepth';
import { packCellIndex, packCellKey } from '@core/geo/marinePacks';
import * as marinePackFiles from '@data/marinePacks';
import { useMarineChart } from './useMarineChart';

const mockFiles = new Map<string, Uint8Array>();
let mockSerial = 0;
jest.mock('@data/storage', () => ({
  fileExists: (uri: string) => mockFiles.has(uri),
  writeChartPng: (id: string, bytes: Uint8Array) => {
    const uri = `file://${id}_${++mockSerial}.png`;
    mockFiles.set(uri, bytes);
    // Match storage's two-generation retention, including progressive renders.
    const own = [...mockFiles.keys()].filter((key) => key.startsWith(`file://${id}_`));
    for (const stale of own.slice(0, -2)) mockFiles.delete(stale);
    return uri;
  },
}));
jest.mock('@data/marinePacks', () => ({ readPackCell: jest.fn() }));
jest.mock('@core/geo/floatTiff', () => {
  const { latToMercY, lonToMercX } =
    jest.requireActual<typeof import('@core/geo/marineDepth')>('@core/geo/marineDepth');
  return {
    parseFloat32Grid: (bytes: Uint8Array) => ({
      width: 8,
      height: 8,
      data: new Float32Array(64).fill(-(bytes[0] ?? 10)),
      x0: lonToMercX(-71.28),
      y0: latToMercY(46.88),
      dx: 20,
      dy: 20,
    }),
  };
});

const bounds: GeoBbox = { west: -71.28, east: -71.26, south: 46.82, north: 46.84 };
const packKey = packCellKey('nonna', packCellIndex(46.83), packCellIndex(-71.27));
const flush = async () => {
  await act(async () => {
    jest.advanceTimersByTime(0);
  });
};
const label = (chart: ReturnType<typeof useMarineChart>['chart']) =>
  chart?.soundings.features[0]?.properties.label;

beforeEach(() => {
  jest.useFakeTimers();
  mockFiles.clear();
  jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    arrayBuffer: async () => new Uint8Array([10]).buffer,
  } as Response);
  jest.mocked(marinePackFiles.readPackCell).mockResolvedValue(new Uint8Array([20]));
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it('rebuilds a cached chart whose PNG was removed by later renders', async () => {
  const installed = new Set<string>();
  const view = await renderHook(
    ({ b }: { b: GeoBbox }) => useMarineChart(true, b, false, installed),
    {
      initialProps: { b: bounds },
    },
  );
  await flush();
  const first = view.result.current.chart?.drape.uri;
  expect(first).toBeDefined();
  await view.rerender({ b: { ...bounds, west: -70.28, east: -70.26 } });
  await flush();
  expect(mockFiles.has(first ?? '')).toBe(false);
  await view.rerender({ b: bounds });
  await flush();
  expect(mockFiles.has(view.result.current.chart?.drape.uri ?? '')).toBe(true);
  expect(mockFiles.size).toBeLessThanOrEqual(2);
  await view.unmount();
});

it('updates sounding units without moving the viewport, including cached revisits', async () => {
  const installed = new Set<string>();
  const view = await renderHook(
    ({ imperial }: { imperial: boolean }) => useMarineChart(true, bounds, imperial, installed),
    {
      initialProps: { imperial: false },
    },
  );
  await flush();
  expect(label(view.result.current.chart)).toBe('10');
  await view.rerender({ imperial: true });
  await flush();
  expect(label(view.result.current.chart)).toBe('33');
  await view.rerender({ imperial: false });
  await flush();
  expect(label(view.result.current.chart)).toBe('10');
  await view.unmount();
});

it('uses newly installed packs at unchanged bounds even when the version value collides', async () => {
  const view = await renderHook(
    ({ installed }: { installed: Set<string> }) =>
      useMarineChart(true, bounds, false, installed, 10),
    {
      initialProps: { installed: new Set<string>() },
    },
  );
  await flush();
  expect(view.result.current.chart?.offline).toBe(false);
  await view.rerender({ installed: new Set([packKey]) });
  await flush();
  expect(view.result.current.chart?.offline).toBe(true);
  expect(label(view.result.current.chart)).toBe('20');
  // Refreshing an existing cell can preserve its byte count and all keys.
  jest.mocked(marinePackFiles.readPackCell).mockResolvedValue(new Uint8Array([25]));
  await view.rerender({ installed: new Set([packKey]) });
  await flush();
  expect(label(view.result.current.chart)).toBe('25');
  await view.unmount();
});

it('refreshes a changed pack revision at the same viewport', async () => {
  const installed = new Set([packKey]);
  const view = await renderHook(
    ({ version }: { version: number }) => useMarineChart(true, bounds, false, installed, version),
    {
      initialProps: { version: 1 },
    },
  );
  await flush();
  expect(label(view.result.current.chart)).toBe('20');
  jest.mocked(marinePackFiles.readPackCell).mockResolvedValue(new Uint8Array([25]));
  await view.rerender({ version: 2 });
  await flush();
  expect(label(view.result.current.chart)).toBe('25');
  await view.unmount();
});

it('does not write a superseded offline render into the shared raster files', async () => {
  const installed = new Set([packKey]);
  let finish!: (bytes: Uint8Array) => void;
  jest.mocked(marinePackFiles.readPackCell).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = await renderHook(
    ({ imperial }: { imperial: boolean }) => useMarineChart(true, bounds, imperial, installed, 99),
    {
      initialProps: { imperial: false },
    },
  );
  await view.rerender({ imperial: true });
  await flush();
  const files = [...mockFiles.keys()];
  expect(files.length).toBeGreaterThan(0);
  await act(async () => {
    finish(new Uint8Array([10]));
  });
  expect([...mockFiles.keys()]).toEqual(files);
  await view.unmount();
});
