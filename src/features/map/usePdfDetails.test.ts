import { act, renderHook } from '@testing-library/react-native';
import { usePdfDetails } from './usePdfDetails';
import type { MapDocument } from '@core/models';
import type { PdfOverlay } from './usePdfOverlay';
import { planPdfDetail, type PdfDetailPlan } from '@core/geo/pdfDetail';

const mockPlans = jest.fn();
jest.mock('@core/geo/pdfDetail', () => ({
  ...jest.requireActual('@core/geo/pdfDetail'),
  planPdfDetailTiles: (...args: unknown[]) => mockPlans(...args),
}));

const mockRasterize = jest.fn();
const mockServerOrigin = async () => 'http://127.0.0.1:1234';
const mockFiles = new Map<string, string>();
jest.mock('./PdfRasterizer', () => ({
  usePdfRasterizer: () => mockRasterize,
  usePdfRasterizerServer: () => mockServerOrigin,
}));
jest.mock('@data/storage', () => ({
  clearPdfDetailPngs: () => undefined,
  toDocumentPath: (p: string) => p,
  resolveDocumentPath: (p: string) => p,
  fileSizeAt: () => 216_000_000,
  readFileBase64: () => {
    throw new Error('Large file must not cross bridge');
  },
  writeOverlayPng: (id: string, data: string) => {
    const uri = `file://${id}`;
    mockFiles.set(uri, data);
    return uri;
  },
  deleteFileAt: (uri: string) => mockFiles.delete(uri),
}));
jest.mock('expo-file-system', () => ({
  File: class {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    get exists() {
      return mockFiles.has(this.uri);
    }
  },
}));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));
const map: MapDocument = {
  id: 'map',
  name: 'Map',
  fileUri: 'maps/map.pdf',
  importedAt: 1,
  pageCount: 1,
  activePages: [0],
  georeferences: [
    {
      pageIndex: 0,
      source: 'adobe-geo',
      pageWidthPt: 1000,
      pageHeightPt: 1000,
    } as MapDocument['georeferences'][number],
  ],
};
const overview: PdfOverlay = {
  id: 'map:0',
  imageUri: 'file://overview',
  coordinates: [
    [-71, 47],
    [-70, 47],
    [-70, 46],
    [-71, 46],
  ],
  bbox: { minLng: -71, maxLng: -70, minLat: 46, maxLat: 47 },
};
const bounds = { west: -70.6, east: -70.5, north: 46.5, south: 46.4 };
const raster = { pngDataUri: 'data:image/png;base64,DETAIL' };
const flush = async () => {
  await act(async () => {
    jest.advanceTimersByTime(300);
  });
};
beforeEach(() => {
  jest.useFakeTimers();
  mockFiles.clear();
  mockRasterize.mockReset().mockResolvedValue(raster);
  mockPlans.mockReset().mockImplementation((...args: Parameters<typeof planPdfDetail>) => {
    const plan = planPdfDetail(...args);
    return plan ? [{ ...plan, tileKey: JSON.stringify(plan.crop) }] : [];
  });
});
afterEach(() => jest.useRealTimers());

it('refines a large PDF over the served path and retains the overview on failure', async () => {
  const v = await renderHook(() => usePdfDetails([map], [overview], bounds, 1200));
  await flush();
  expect(v.result.current[0]?.imageUri).toBeDefined();
  expect(v.result.current[0]).toMatchObject({ parentId: overview.id });
  expect(mockRasterize.mock.calls[0]?.[0]).toMatchObject({
    source: { url: 'http://127.0.0.1:1234/maps/map.pdf' },
    crop: expect.any(Object),
  });
  await v.unmount();
  expect(mockFiles.size).toBe(0);
  mockRasterize.mockRejectedValue(new Error('render failed'));
  const failed = await renderHook(() => usePdfDetails([map], [overview], bounds, 1200));
  await flush();
  expect(failed.result.current).toEqual([]);
  await failed.unmount();
});

it('coalesces camera changes while a render is running and ignores the old result', async () => {
  let resolveFirst!: (value: typeof raster) => void;
  mockRasterize.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
  );
  const v = await renderHook(
    ({ b }: { b: typeof bounds }) => usePdfDetails([map], [overview], b, 1200),
    { initialProps: { b: bounds } },
  );
  await flush();
  for (const shift of [0.1, 0.2, 0.3]) {
    await v.rerender({ b: { ...bounds, west: bounds.west + shift, east: bounds.east + shift } });
    await flush();
  }
  expect(mockRasterize).toHaveBeenCalledTimes(1);
  await act(async () => {
    resolveFirst(raster);
  });
  expect(mockRasterize).toHaveBeenCalledTimes(2);
  expect(v.result.current[0]?.coordinates[0][0]).toBeGreaterThan(-70.4);
  await v.unmount();
});

it('hides detail immediately when the overview revision changes', async () => {
  const v = await renderHook(
    ({ o }: { o: PdfOverlay }) => usePdfDetails([map], [o], bounds, 1200),
    { initialProps: { o: overview } },
  );
  await flush();
  expect(v.result.current).toHaveLength(1);
  await v.rerender({ o: { ...overview, imageUri: 'file://replacement' } });
  expect(v.result.current).toEqual([]);
  await v.unmount();
});

it('bounds cache files while panning and keeps the visible image available', async () => {
  const v = await renderHook(
    ({ b }: { b: typeof bounds }) => usePdfDetails([map], [overview], b, 1200),
    { initialProps: { b: bounds } },
  );
  await flush();
  for (let i = 1; i <= 12; i++) {
    await v.rerender({
      b: { ...bounds, west: bounds.west + i * 0.02, east: bounds.east + i * 0.02 },
    });
    await flush();
    expect(mockFiles.size).toBeLessThanOrEqual(64);
    expect(mockFiles.has(v.result.current[0]!.imageUri)).toBe(true);
  }
  await act(async () => {
    jest.advanceTimersByTime(2000);
  });
  expect(mockFiles.size).toBeLessThanOrEqual(64);
  await v.unmount();
  expect(mockFiles.size).toBe(0);
});

const tile = (tileKey: string, x: number): PdfDetailPlan & { tileKey: string } => ({
  tileKey,
  crop: { x0: x, y0: 0.25, x1: x + 0.125, y1: 0.375 },
  targetWidthPx: 512,
  coordinates: [
    [-71 + x, 46.75],
    [-71 + x + 0.125, 46.75],
    [-71 + x + 0.125, 46.625],
    [-71 + x, 46.625],
  ],
});

it('shows the first completed tile before the rest and gives adjacent tiles distinct IDs', async () => {
  mockPlans.mockReturnValue([tile('a', 0.25), tile('b', 0.375)]);
  let finish!: (value: typeof raster) => void;
  mockRasterize.mockResolvedValueOnce(raster).mockImplementationOnce(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const v = await renderHook(() => usePdfDetails([map], [overview], bounds, 1200));
  await flush();
  expect(mockRasterize).toHaveBeenCalledTimes(2);
  expect(v.result.current.map((d) => d.id)).toEqual(['map:0:tile:a']);
  await act(async () => finish(raster));
  expect(v.result.current.map((d) => d.id)).toEqual(['map:0:tile:a', 'map:0:tile:b']);
  expect(v.result.current[0]?.coordinates[1]).toEqual(v.result.current[1]?.coordinates[0]);
  await v.unmount();
});

it('reuses matching tiles immediately on pan while rendering only newly visible tiles', async () => {
  mockPlans.mockReturnValue([tile('a', 0.25), tile('b', 0.375)]);
  const v = await renderHook(
    ({ b }: { b: typeof bounds }) => usePdfDetails([map], [overview], b, 1200),
    { initialProps: { b: bounds } },
  );
  await flush();
  const retained = v.result.current[1]?.imageUri;
  mockPlans.mockReturnValue([tile('b', 0.375), tile('c', 0.5)]);
  await v.rerender({ b: { ...bounds, east: bounds.east + 0.01 } });
  expect(v.result.current.map((d) => d.id)).toEqual(['map:0:tile:b']);
  expect(v.result.current[0]?.imageUri).toBe(retained);
  await flush();
  expect(mockRasterize).toHaveBeenCalledTimes(3);
  expect(v.result.current.map((d) => d.id)).toEqual(['map:0:tile:b', 'map:0:tile:c']);
  await v.unmount();
});

it('divides the six Mi-pixel visible budget by the number of eligible pages', async () => {
  mockPlans.mockReturnValue([tile('a', 0.25)]);
  const v = await renderHook(() => usePdfDetails([map], [overview], bounds, 1200));
  await flush();
  expect(mockPlans.mock.calls.at(-1)?.[4]).toBe(6 * 1024 * 1024);
  await v.unmount();
  mockPlans.mockClear();
  const secondMap = { ...map, id: 'second' };
  const both = await renderHook(() =>
    usePdfDetails([map, secondMap], [overview, { ...overview, id: 'second:0' }], bounds, 1200),
  );
  await flush();
  expect(mockPlans.mock.calls.slice(-2).map((c) => c[4])).toEqual([
    3 * 1024 * 1024,
    3 * 1024 * 1024,
  ]);
  expect(new Set(both.result.current.map((d) => d.id)).size).toBe(2);
  await both.unmount();
});

it('bounds actual raster pixels during pan handoff and delayed settled cleanup', async () => {
  const pixels = 1280 * 2048;
  mockRasterize.mockResolvedValue({ ...raster, widthPx: 1280, heightPx: 2048 });
  mockPlans.mockReturnValue([tile('0', 0.25)]);
  const v = await renderHook(
    ({ b }: { b: typeof bounds }) => usePdfDetails([map], [overview], b, 1200),
    { initialProps: { b: bounds } },
  );
  await flush();
  for (let i = 1; i <= 20; i++) {
    mockPlans.mockReturnValue([tile(String(i), 0.25)]);
    await v.rerender({ b: { ...bounds, east: bounds.east + i / 1000 } });
    await flush();
    expect(mockFiles.size * pixels).toBeLessThanOrEqual(18 * 1024 * 1024);
    expect(mockFiles.has(v.result.current[0]!.imageUri)).toBe(true);
  }
  await act(async () => {
    jest.advanceTimersByTime(2000);
  });
  expect(mockFiles.size * pixels).toBeLessThanOrEqual(12 * 1024 * 1024);
  expect(mockFiles.has(v.result.current[0]!.imageUri)).toBe(true);
  await v.unmount();
  expect(mockFiles.size).toBe(0);
});

it('bounds tiny cached files independently of their pixel budget', async () => {
  mockRasterize.mockResolvedValue({ ...raster, widthPx: 16, heightPx: 16 });
  mockPlans.mockReturnValue([tile('0', 0.25)]);
  const v = await renderHook(
    ({ b }: { b: typeof bounds }) => usePdfDetails([map], [overview], b, 1200),
    { initialProps: { b: bounds } },
  );
  await flush();
  for (let i = 1; i <= 70; i++) {
    mockPlans.mockReturnValue([tile(String(i), 0.25)]);
    await v.rerender({ b: { ...bounds, east: bounds.east + i / 1000 } });
    await flush();
    expect(mockFiles.size).toBeLessThanOrEqual(64);
  }
  expect(mockFiles.size).toBe(64);
  expect(mockFiles.has(v.result.current[0]!.imageUri)).toBe(true);
  await v.unmount();
  expect(mockFiles.size).toBe(0);
});

it('bounds obsolete native completions while the camera keeps moving', async () => {
  const completions: ((value: { fileUri: string; widthPx: number; heightPx: number }) => void)[] =
    [];
  mockRasterize.mockImplementation(
    () =>
      new Promise((resolve) => {
        completions.push(resolve);
      }),
  );
  mockPlans.mockReturnValue([tile('0', 0.25)]);
  const v = await renderHook(
    ({ b }: { b: typeof bounds }) => usePdfDetails([map], [overview], b, 1200),
    { initialProps: { b: bounds } },
  );
  await flush();
  for (let i = 1; i <= 12; i++) {
    mockPlans.mockReturnValue([tile(String(i), 0.25)]);
    await v.rerender({ b: { ...bounds, east: bounds.east + i / 1000 } });
    const uri = `file://pdf-detail-native-stale-${i}.png`;
    mockFiles.set(uri, 'native');
    await act(async () => {
      completions[i - 1]!({ fileUri: uri, widthPx: 1536, heightPx: 2048 });
    });
    expect(v.result.current).toEqual([]);
    expect(mockFiles.size * 3 * 1024 * 1024).toBeLessThanOrEqual(18 * 1024 * 1024);
  }
  await v.unmount();
  const late = 'file://pdf-detail-native-last.png';
  mockFiles.set(late, 'native');
  await act(async () => {
    completions[12]!({ fileUri: late, widthPx: 1536, heightPx: 2048 });
  });
  expect(mockFiles.size).toBe(0);
});

it('consumes every real planned tile and reuses them across a tiny pan', async () => {
  const actual = jest.requireActual<typeof import('@core/geo/pdfDetail')>('@core/geo/pdfDetail');
  mockPlans.mockImplementation(actual.planPdfDetailTiles);
  const expected = actual.planPdfDetailTiles(
    overview.coordinates,
    { width: 1000, height: 1000 },
    bounds,
    1200,
    6 * 1024 * 1024,
  );
  expect(expected.length).toBeGreaterThan(1);
  const v = await renderHook(
    ({ b }: { b: typeof bounds }) => usePdfDetails([map], [overview], b, 1200),
    { initialProps: { b: bounds } },
  );
  await flush();
  expect(v.result.current.map((d) => d.id)).toEqual(
    expected.map((plan) => `map:0:tile:${plan.tileKey}`),
  );
  expect(mockRasterize).toHaveBeenCalledTimes(expected.length);
  const uris = new Set(v.result.current.map((d) => d.imageUri));
  await v.rerender({
    b: { ...bounds, east: bounds.east + 0.000001, west: bounds.west + 0.000001 },
  });
  await flush();
  expect(mockRasterize).toHaveBeenCalledTimes(expected.length);
  expect(new Set(v.result.current.map((d) => d.imageUri))).toEqual(uris);
  await v.unmount();
  expect(mockFiles.size).toBe(0);
});

it('does not write a crop completing after unmount', async () => {
  let resolve!: (value: typeof raster) => void;
  mockRasterize.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const v = await renderHook(() => usePdfDetails([map], [overview], bounds, 1200));
  await flush();
  await v.unmount();
  await act(async () => resolve(raster));
  expect(mockFiles.size).toBe(0);
});

it('uses a native PNG directly and includes verified page dimensions in the request', async () => {
  const uri = 'file://pdf-detail-native-current.png';
  mockFiles.set(uri, 'native');
  mockRasterize.mockResolvedValue({ fileUri: uri });
  const v = await renderHook(() => usePdfDetails([map], [overview], bounds, 1200));
  await flush();
  expect(v.result.current[0]?.imageUri).toBe(uri);
  expect(mockRasterize.mock.calls[0]?.[0]).toMatchObject({
    nativePage: { fileUri: map.fileUri, expectedPageWidthPt: 1000, expectedPageHeightPt: 1000 },
  });
  expect(mockFiles.size).toBe(1);
  await v.unmount();
  expect(mockFiles.size).toBe(0);
});

it('deletes a native file returned after the detail hook unmounted', async () => {
  let resolve!: (value: { fileUri: string }) => void;
  mockRasterize.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const v = await renderHook(() => usePdfDetails([map], [overview], bounds, 1200));
  await flush();
  await v.unmount();
  const uri = 'file://pdf-detail-native-obsolete.png';
  mockFiles.set(uri, 'native');
  await act(async () => resolve({ fileUri: uri }));
  expect(mockFiles.size).toBe(0);
});

it('uses the physical map height when a portrait viewport rotates', async () => {
  const actual = jest.requireActual<typeof import('@core/geo/pdfDetail')>('@core/geo/pdfDetail');
  mockPlans.mockImplementation(actual.planPdfDetailTiles);
  const lng = (x: number) => (x * 180) / Math.PI;
  const lat = (y: number) => ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
  const square: PdfOverlay = {
    ...overview,
    coordinates: [
      [lng(-1.2), lat(0.81)],
      [lng(-1.19), lat(0.81)],
      [lng(-1.19), lat(0.8)],
      [lng(-1.2), lat(0.8)],
    ],
  };
  const rotatedBounds = {
    west: lng(-1.195 - 0.0005),
    east: lng(-1.195 + 0.0005),
    south: lat(0.805 - 0.00025),
    north: lat(0.805 + 0.00025),
  };
  const viewport = { heightPx: 2400, bearing: 90 };
  const expected = actual.planPdfDetailTiles(
    square.coordinates,
    { width: 1000, height: 1000 },
    rotatedBounds,
    1200,
    6 * 1024 * 1024,
    viewport,
  );
  expect(expected.length).toBeGreaterThan(0);
  const v = await renderHook(() => usePdfDetails([map], [square], rotatedBounds, 1200, viewport));
  await flush();
  expect(v.result.current.map((detail) => detail.id)).toEqual(
    expected.map((plan) => `map:0:tile:${plan.tileKey}`),
  );
  await v.unmount();
});
