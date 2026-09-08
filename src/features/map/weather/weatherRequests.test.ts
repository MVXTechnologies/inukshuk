import { act, renderHook } from '@testing-library/react-native';
import citypage from '@core/weather/__fixtures__/citypage-collection.json';
import tideStations from '@core/weather/__fixtures__/iwls-stations.json';
import { useForecast } from './useForecast';
import { useTides } from './useTides';
import { useWeatherPointValue } from './useWeatherPointValue';
import { useCompareMatrix } from './useCompareMatrix';

const at = { latitude: 46.8139, longitude: -71.208 };
const response = (body: unknown) => ({ ok: true, json: async () => body }) as Response;
let fetchMock: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-08-09T00:31:00Z'));
  fetchMock = jest.spyOn(global, 'fetch');
});
afterEach(() => {
  fetchMock.mockRestore();
  jest.useRealTimers();
});

it('publishes citypage while optional layer information remains hung', async () => {
  fetchMock.mockImplementation((url: string) =>
    url.includes('citypage') ? Promise.resolve(response(citypage)) : new Promise(() => {}),
  );
  const view = await renderHook(() => useForecast(at, 'temp'));
  expect(view.result.current.status).toBe('ready');
  expect(view.result.current.forecast?.site).toBe('Vanier');
  expect(view.result.current.layerValue).toBeNull();
  await view.unmount();
});

it.each(['forecast', 'tides', 'point'] as const)(
  '%s times out stalled network work',
  async (kind) => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const view = await renderHook(() => {
      const forecast = useForecast(kind === 'forecast' ? at : null, null);
      const tides = useTides(kind === 'tides' ? at : null, 100000);
      const point = useWeatherPointValue(at, 'temp', 'hrdps', undefined);
      return kind === 'forecast' ? forecast : kind === 'tides' ? tides : point;
    });
    expect(view.result.current.status).toBe('loading');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(13000);
    });
    expect(view.result.current.status).toBe('error');
    expect(fetchMock.mock.calls.every(([, options]) => options?.signal?.aborted)).toBe(true);
    await view.unmount();
  },
);

it('aborts all outstanding requests when their card closes', async () => {
  fetchMock.mockImplementation(() => new Promise(() => {}));
  const view = await renderHook(() => {
    useForecast(at, 'temp');
    useTides(at, 100000);
    useWeatherPointValue(at, 'temp', 'hrdps', undefined);
  });
  const signals = fetchMock.mock.calls.map(([, options]) => options?.signal);
  await view.unmount();
  expect(signals.length).toBeGreaterThanOrEqual(4);
  expect(signals.every((signal) => signal?.aborted)).toBe(true);
});

it('keeps the comparison usable when a warm cache hit survives failed requests', async () => {
  fetchMock.mockRejectedValue(new Error('offline'));
  fetchMock.mockResolvedValueOnce(response({ features: [{ properties: { value: 12 } }] }));
  const first = await renderHook(() => useCompareMatrix(at, 'temp'));
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(120000);
  });
  expect([...first.result.current.cells.values()]).toContain(12);
  await first.unmount();
  const next = await renderHook(() => useCompareMatrix(at, 'temp'));
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(120000);
  });
  expect([...next.result.current.cells.values()]).toContain(12);
  expect(next.result.current.allFailed).toBe(false);
  await next.unmount();
});

it('adds optional grid information after the forecast is already ready', async () => {
  let finishValue: (response: Response) => void = () => {};
  fetchMock.mockImplementation((url: string) =>
    url.includes('citypage')
      ? Promise.resolve(response(citypage))
      : new Promise<Response>((resolve) => {
          finishValue = resolve;
        }),
  );
  const view = await renderHook(() => useForecast(at, 'temp'));
  expect(view.result.current.status).toBe('ready');
  await act(async () => {
    finishValue(response({ features: [{ properties: { value: 12 } }] }));
  });
  expect(view.result.current.status).toBe('ready');
  expect(view.result.current.layerValue?.value).toBe(12);
  await view.unmount();
});

it('bounds a JSON body read even after response headers arrive', async () => {
  fetchMock.mockResolvedValue({ ok: true, json: () => new Promise(() => {}) });
  const view = await renderHook(() => useWeatherPointValue(at, 'temp', 'hrdps', undefined));
  await act(async () => {
    await jest.advanceTimersByTimeAsync(13000);
  });
  expect(view.result.current.status).toBe('error');
  expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  await view.unmount();
});

it('aborts superseded point requests and ignores late results', async () => {
  let currentAt = at;
  let finishOld: (response: Response) => void = () => {};
  fetchMock.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finishOld = resolve;
      }),
  );
  fetchMock.mockResolvedValue(response({ features: [{ properties: { value: 20 } }] }));
  const view = await renderHook(() => useWeatherPointValue(currentAt, 'temp', 'hrdps', undefined));
  const oldSignal = fetchMock.mock.calls[0]?.[1]?.signal;
  currentAt = { ...at, longitude: at.longitude + 1 };
  await view.rerender(undefined);
  expect(oldSignal?.aborted).toBe(true);
  expect(view.result.current.value?.value).toBe(20);
  await act(async () => {
    finishOld(response({ features: [{ properties: { value: 99 } }] }));
  });
  expect(view.result.current.value?.value).toBe(20);
  await view.unmount();
});

it('bounds tide series requests after the station list succeeds', async () => {
  fetchMock.mockImplementation((url: string) =>
    url.includes('/data?') ? new Promise(() => {}) : Promise.resolve(response(tideStations)),
  );
  const view = await renderHook(() => useTides(at, 100000));
  expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/data?'))).toHaveLength(2);
  await act(async () => {
    await jest.advanceTimersByTimeAsync(13000);
  });
  expect(view.result.current.status).toBe('error');
  const seriesCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/data?'));
  expect(seriesCalls.every(([, options]) => options?.signal?.aborted)).toBe(true);
  await view.unmount();
});
