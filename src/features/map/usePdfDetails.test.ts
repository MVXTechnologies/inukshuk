import { PdfRenderNotStartedError } from './pdfRenderFailure';
import { useOverlayStatusStore } from '@state/overlayStatusStore';
import { renderStatusLine } from '@core/library/overlayStatus';
import { act, renderHook } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { usePdfDetails } from './usePdfDetails';
import type { MapDocument } from '@core/models';
import type { PdfOverlay } from './usePdfOverlay';
import { planPdfDetail, type PdfDetailPlan } from '@core/geo/pdfDetail';
import { pdfTileBudgets } from '@core/geo/pdfTileCache';
import { pageToMercator } from '@core/geo/pdfDetailBlocks';

const BUDGETS = pdfTileBudgets(false);

const mockPlans = jest.fn();
jest.mock('@core/geo/pdfDetail', () => ({
  ...jest.requireActual('@core/geo/pdfDetail'),
  planPdfDetailTiles: (...args: unknown[]) => mockPlans(...args),
}));

const mockRasterize = jest.fn();
const mockServerOrigin = jest.fn<Promise<string | null>, []>();
const mockFileSize = jest.fn<number, [string]>();
const mockReadBase64 = jest.fn<Promise<string>, [string]>();
const mockFiles = new Map<string, string>();
jest.mock('./PdfRasterizer', () => ({
  usePdfRasterizer: () => mockRasterize,
  usePdfRasterizerServer: () => mockServerOrigin,
}));
jest.mock('@data/storage', () => ({
  clearPdfDetailPngs: () => undefined,
  toDocumentPath: (p: string) => p,
  resolveDocumentPath: (p: string) => p,
  fileSizeAt: (uri: string) => mockFileSize(uri),
  readFileBase64: (uri: string) => mockReadBase64(uri),
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
/** The shown raster (a tile or a block) holding grid cell `tileKey`, if any. */
const heldBy = (shown: PdfOverlay[], tileKey: string) => {
  const [d, x, y] = tileKey.split(':').map(Number) as [number, number, number];
  return shown.find((o) => {
    const m = /:tile:(\d+):(\d+):(\d+):(\d+)(?::(\d+)x(\d+))?$/.exec(o.id);
    if (!m || Number(m[1]) !== d) return false;
    const [bx, by, cols, rows] = [Number(m[2]), Number(m[3]), Number(m[5] ?? 1), Number(m[6] ?? 1)];
    return x >= bx && x < bx + cols && y >= by && y < by + rows;
  });
};
beforeEach(() => {
  jest.useFakeTimers();
  useOverlayStatusStore.setState({ statuses: { 'map:0': { phase: 'rendered' } } });
  mockFiles.clear();
  mockRasterize.mockReset().mockResolvedValue(raster);
  mockServerOrigin.mockReset().mockResolvedValue('http://127.0.0.1:1234');
  mockFileSize.mockReset().mockReturnValue(216_000_000);
  mockReadBase64.mockReset().mockImplementation(() => {
    throw new Error('Large file must not cross bridge');
  });
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
  // The fresh tile is drawn last (on top); the stale one may stay under it.
  expect(v.result.current.at(-1)?.coordinates[0][0]).toBeGreaterThan(-70.4);
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

it('retains real planner tiles across a small pan through a grid alignment boundary', async () => {
  const actual = jest.requireActual<typeof import('@core/geo/pdfDetail')>('@core/geo/pdfDetail');
  mockPlans.mockImplementation(actual.planPdfDetailTiles);
  const before = { west: -70.632, east: -70.532, south: 46.4, north: 46.55 };
  const after = { ...before, west: -70.631, east: -70.531 };
  const view = await renderHook(
    ({ b }: { b: typeof bounds }) => usePdfDetails([map], [overview], b, 1200),
    { initialProps: { b: before } },
  );
  await flush();
  const original = new Map(view.result.current.map((d) => [d.id, d.imageUri]));
  const initialRequests = mockRasterize.mock.calls.length;
  expect(original.size).toBeGreaterThan(1);
  await view.rerender({ b: after });
  // The real planner used to change its entire grid at this boundary. The
  // existing mocked-planner test could not catch that cache invalidation.
  expect(view.result.current.length).toBeGreaterThan(0);
  for (const detail of view.result.current) {
    expect(detail.imageUri).toBe(original.get(detail.id));
  }
  const retained = view.result.current.length;
  await flush();
  expect(mockRasterize.mock.calls.length - initialRequests).toBe(
    view.result.current.length - retained,
  );
  expect(mockRasterize.mock.calls.length - initialRequests).toBeLessThan(initialRequests);
  await view.unmount();
});

it('stops scheduling on blur and reuses completed tiles when focus returns', async () => {
  mockPlans.mockReturnValue([tile('a', 0.25), tile('b', 0.375), tile('c', 0.5)]);
  let finish!: (value: typeof raster) => void;
  mockRasterize.mockResolvedValueOnce(raster).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = await renderHook(
    ({ focused }: { focused: boolean }) =>
      usePdfDetails([map], [overview], bounds, 1200, undefined, focused),
    { initialProps: { focused: true } },
  );
  await flush();
  expect(mockRasterize).toHaveBeenCalledTimes(2);
  const cachedUri = view.result.current[0]?.imageUri;
  await view.rerender({ focused: false });
  await act(async () => finish(raster));
  await flush();
  expect(mockRasterize).toHaveBeenCalledTimes(2);
  expect(view.result.current[0]?.imageUri).toBe(cachedUri);
  await view.rerender({ focused: true });
  expect(view.result.current.map((d) => d.id)).toEqual(['map:0:tile:a', 'map:0:tile:b']);
  await flush();
  expect(mockRasterize).toHaveBeenCalledTimes(3);
  expect(view.result.current).toHaveLength(3);
  await view.unmount();
});

it('cancels debounced refinement when focus leaves before dispatch', async () => {
  mockPlans.mockReturnValue([tile('a', 0.25)]);
  const view = await renderHook(
    ({ focused }: { focused: boolean }) =>
      usePdfDetails([map], [overview], bounds, 1200, undefined, focused),
    { initialProps: { focused: true } },
  );
  await view.rerender({ focused: false });
  await flush();
  expect(mockRasterize).not.toHaveBeenCalled();
  await view.unmount();
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
    expect(mockFiles.size * pixels).toBeLessThanOrEqual(BUDGETS.handoffPixels);
    expect(mockFiles.has(v.result.current[0]!.imageUri)).toBe(true);
  }
  await act(async () => {
    jest.advanceTimersByTime(2000);
  });
  expect(mockFiles.size * pixels).toBeLessThanOrEqual(BUDGETS.settledPixels);
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
  for (let i = 1; i <= BUDGETS.cacheFiles + 6; i++) {
    mockPlans.mockReturnValue([tile(String(i), 0.25)]);
    await v.rerender({ b: { ...bounds, east: bounds.east + i / 1000 } });
    await flush();
    expect(mockFiles.size).toBeLessThanOrEqual(BUDGETS.cacheFiles);
  }
  expect(mockFiles.size).toBe(BUDGETS.cacheFiles);
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
    expect(mockFiles.size * 3 * 1024 * 1024).toBeLessThanOrEqual(BUDGETS.handoffPixels);
  }
  await v.unmount();
  const late = 'file://pdf-detail-native-last.png';
  mockFiles.set(late, 'native');
  await act(async () => {
    completions[12]!({ fileUri: late, widthPx: 1536, heightPx: 2048 });
  });
  expect(mockFiles.size).toBe(0);
});

it('consumes real planned tiles, prefetches the ring and pans onto it without rendering', async () => {
  const actual = jest.requireActual<typeof import('@core/geo/pdfDetail')>('@core/geo/pdfDetail');
  mockPlans.mockImplementation(actual.planPdfDetailTiles);
  const options = { prefetchMargin: BUDGETS.prefetchMargin, maxPrefetch: BUDGETS.maxPrefetchTiles };
  const plan = (b: typeof bounds) =>
    actual.planPdfDetailTiles(
      overview.coordinates,
      { width: 1000, height: 1000 },
      b,
      1200,
      6 * 1024 * 1024,
      undefined,
      options,
    );
  const expected = plan(bounds);
  const visible = expected.filter((p) => !p.prefetch);
  expect(visible.length).toBeGreaterThan(1);
  expect(expected.length).toBeGreaterThan(visible.length);
  const v = await renderHook(
    ({ b }: { b: typeof bounds }) => usePdfDetails([map], [overview], b, 1200),
    { initialProps: { b: bounds } },
  );
  await flush();
  // The visible cells are drawn as blocks (one renderer call per block, not
  // per cell) and shown; the ring is rendered after them, at background
  // priority, and kept off screen.
  for (const p of visible) expect(heldBy(v.result.current, p.tileKey!)).toBeDefined();
  const visibleCalls = mockRasterize.mock.calls.filter(([args]) => args.priority === 'interactive');
  expect(visibleCalls.length).toBeLessThan(visible.length);
  const priorities = mockRasterize.mock.calls.map(([args]) => args.priority);
  expect(priorities.slice(0, visibleCalls.length).every((p) => p === 'interactive')).toBe(true);
  expect(priorities.slice(visibleCalls.length).every((p) => p === 'background')).toBe(true);
  expect(mockRasterize.mock.calls.length).toBeLessThan(expected.length);
  const uris = new Map(v.result.current.map((d) => [d.id, d.imageUri]));
  // The original eastern edge lies exactly on page-grid x=.5. Moving east
  // crosses that edge into a column the ring already rendered.
  const nextBounds = { ...bounds, east: bounds.east + 0.000001, west: bounds.west + 0.000001 };
  const nextVisible = plan(nextBounds).filter((p) => !p.prefetch);
  const added = nextVisible.filter((p) => !heldBy(v.result.current, p.tileKey!));
  expect(added).toHaveLength(2);
  const calls = mockRasterize.mock.calls.length;
  await v.rerender({ b: nextBounds });
  // Shown at once, from the prefetched files, before any render could run.
  for (const p of nextVisible) expect(heldBy(v.result.current, p.tileKey!)).toBeDefined();
  await flush();
  // Nothing the view needs is rendered again; only the new ring (background).
  expect(
    mockRasterize.mock.calls.slice(calls).every(([args]) => args.priority === 'background'),
  ).toBe(true);
  for (const [id, uri] of uris) {
    const still = v.result.current.find((d) => d.id === id);
    if (still) expect(still.imageUri).toBe(uri);
  }
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

it('never offers native rendering for a page whose rendered box has a nonzero origin (#287)', async () => {
  // Android PdfRenderer and the iOS crops only accept a zero-origin page whose
  // CropBox is its MediaBox; a /CropBox [50 25 150 75] page must stay on
  // pdf.js, which renders (and crops) the CropBox itself.
  const cropped: MapDocument = {
    ...map,
    georeferences: [
      {
        ...map.georeferences[0]!,
        pageWidthPt: 100,
        pageHeightPt: 50,
        pageBox: { x0: 50, y0: 25, x1: 150, y1: 75 },
      },
    ],
  };
  const v = await renderHook(() => usePdfDetails([cropped], [overview], bounds, 1200));
  await flush();
  expect(mockRasterize).toHaveBeenCalledTimes(1);
  expect(mockRasterize.mock.calls[0]?.[0]).toMatchObject({ nativePage: null });
  expect(mockPlans.mock.calls[0]?.[1]).toEqual({ width: 100, height: 50 });
  await v.unmount();
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
  // Every planned cell is on screen, drawn in fewer renderer calls than cells.
  for (const plan of expected) expect(heldBy(v.result.current, plan.tileKey!)).toBeDefined();
  const interactive = mockRasterize.mock.calls.filter(([args]) => args.priority === 'interactive');
  if (expected.length > 1) expect(interactive.length).toBeLessThan(expected.length);
  await v.unmount();
});

it('reports detail loading and timeout in the Library without changing overview success', async () => {
  let fail!: (error: Error) => void;
  mockRasterize.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  await renderHook(() => usePdfDetails([map], [overview], bounds, 1200));
  await flush();
  expect(renderStatusLine(map, useOverlayStatusStore.getState().statuses)).toEqual({
    kind: 'rendering',
    text: 'Rendering page 1 detail…',
  });
  await act(async () => fail(new Error('render timed out after 45000ms')));
  expect(renderStatusLine(map, useOverlayStatusStore.getState().statuses)?.text).toBe(
    "Couldn't render page 1 detail: render timed out after 45000ms",
  );
  expect(useOverlayStatusStore.getState().statuses['map:0']).toEqual({ phase: 'rendered' });
});

it('retains a sibling tile failure until all tiles succeed in a real retry', async () => {
  const plan = planPdfDetail(overview.coordinates, { width: 1000, height: 1000 }, bounds, 1200)!;
  mockPlans.mockReturnValue([
    { ...plan, tileKey: 'first' },
    { ...plan, tileKey: 'second' },
  ]);
  mockRasterize.mockRejectedValueOnce(new Error('first tile failed')).mockResolvedValueOnce(raster);
  const view = await renderHook(
    ({ b }: { b: typeof bounds }) => usePdfDetails([map], [overview], b, 1200),
    { initialProps: { b: bounds } },
  );
  await flush();
  expect(renderStatusLine(map, useOverlayStatusStore.getState().statuses)?.text).toContain(
    'first tile failed',
  );
  mockPlans.mockReturnValue([
    { ...plan, tileKey: 'retry-first' },
    { ...plan, tileKey: 'retry-second' },
  ]);
  await view.rerender({ b: { ...bounds, west: bounds.west + 0.001 } });
  await flush();
  expect(renderStatusLine(map, useOverlayStatusStore.getState().statuses)).toBeNull();
});

it('clears detail loading when paused and ignores a stale failure', async () => {
  let fail!: (error: Error) => void;
  mockRasterize.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  const view = await renderHook(
    ({ enabled }: { enabled: boolean }) =>
      usePdfDetails([map], [overview], bounds, 1200, undefined, enabled),
    { initialProps: { enabled: true } },
  );
  await flush();
  await view.rerender({ enabled: false });
  expect(renderStatusLine(map, useOverlayStatusStore.getState().statuses)).toBeNull();
  await act(async () => fail(new Error('stale timeout')));
  expect(renderStatusLine(map, useOverlayStatusStore.getState().statuses)).toBeNull();
});

it('clears loading on unmount without erasing the overview error', async () => {
  useOverlayStatusStore.setState({
    statuses: { 'map:0': { phase: 'failed', reason: 'overview failed' } },
  });
  mockRasterize.mockImplementationOnce(() => new Promise(() => undefined));
  const view = await renderHook(() => usePdfDetails([map], [overview], bounds, 1200));
  await flush();
  expect(renderStatusLine(map, useOverlayStatusStore.getState().statuses)?.text).toBe(
    "Couldn't render page 1: overview failed",
  );
  await view.unmount();
  expect(useOverlayStatusStore.getState().statuses['map:0:detail']).toBeUndefined();
  expect(useOverlayStatusStore.getState().statuses['map:0']).toEqual({
    phase: 'failed',
    reason: 'overview failed',
  });
});

it('does not erase another page failure when detail succeeds', async () => {
  useOverlayStatusStore.setState({
    statuses: {
      'map:0': { phase: 'rendered' },
      'map:1:detail': { phase: 'failed', reason: 'page two failed' },
    },
  });
  await renderHook(() => usePdfDetails([map], [overview], bounds, 1200));
  await flush();
  expect(useOverlayStatusStore.getState().statuses['map:1:detail']).toEqual({
    phase: 'failed',
    reason: 'page two failed',
  });
  expect(useOverlayStatusStore.getState().statuses['map:0']).toEqual({ phase: 'rendered' });
});

const mockPauseFailedPage = jest.fn();
jest.mock('@state/libraryStore', () => ({
  useLibraryStore: { getState: () => ({ pauseMapPageAfterRenderFailure: mockPauseFailedPage }) },
}));
beforeEach(() => mockPauseFailedPage.mockClear());
it('pauses a failed detail page before a sibling tile dispatches while other maps continue', async () => {
  const plan = planPdfDetail(overview.coordinates, { width: 1000, height: 1000 }, bounds, 1200)!;
  mockPlans.mockReturnValue([
    { ...plan, tileKey: 'one' },
    { ...plan, tileKey: 'two' },
  ]);
  mockRasterize.mockRejectedValueOnce(new Error('render timed out after 45000ms'));
  const other = { ...map, id: 'other', fileUri: 'maps/other.pdf' };
  await renderHook(() =>
    usePdfDetails([map, other], [{ ...overview, id: 'other:0' }, overview], bounds, 1200),
  );
  await flush();
  expect(mockPauseFailedPage).toHaveBeenCalledWith('map', 0, 'render timed out after 45000ms', {
    fileUri: map.fileUri,
    importedAt: map.importedAt,
  });
  expect(mockRasterize).toHaveBeenCalledTimes(3);
  expect(
    mockRasterize.mock.calls
      .slice(1)
      .every((call) => call[0].source.url.endsWith('/maps/other.pdf')),
  ).toBe(true);
});
it('does not persist a paused-page failure for provider cancellation', async () => {
  mockRasterize.mockRejectedValueOnce(new Error('PdfRasterizer: provider unmounted'));
  await renderHook(() => usePdfDetails([map], [overview], bounds, 1200));
  await flush();
  expect(mockPauseFailedPage).not.toHaveBeenCalled();
});

it('pauses the still-current page when a panned-away tile later times out', async () => {
  let fail!: (error: Error) => void;
  mockRasterize.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  const view = await renderHook(
    ({ b }: { b: typeof bounds }) => usePdfDetails([map], [overview], b, 1200),
    { initialProps: { b: bounds } },
  );
  await flush();
  await view.rerender({ b: { ...bounds, west: bounds.west + 0.002 } });
  await act(async () => fail(new Error('timeout after pan')));
  await flush();
  expect(mockPauseFailedPage).toHaveBeenCalledWith('map', 0, 'timeout after pan', {
    fileUri: map.fileUri,
    importedAt: map.importedAt,
  });
  expect(mockRasterize).toHaveBeenCalledTimes(1);
});

it('pauses an active page even if zooming out removed its desired detail tiles', async () => {
  let fail!: (error: Error) => void;
  mockRasterize.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  const view = await renderHook(
    ({ b }: { b: typeof bounds | null }) => usePdfDetails([map], [overview], b, 1200),
    { initialProps: { b: bounds as typeof bounds | null } },
  );
  await flush();
  await view.rerender({ b: null });
  await act(async () => fail(new Error('timeout after zoom out')));
  expect(mockPauseFailedPage).toHaveBeenCalledWith('map', 0, 'timeout after zoom out', {
    fileUri: map.fileUri,
    importedAt: map.importedAt,
  });
  expect(mockRasterize).toHaveBeenCalledTimes(1);
});
it('does not schedule a paused page even if its old overview is still displayed', async () => {
  await renderHook(() => usePdfDetails([{ ...map, activePages: [] }], [overview], bounds, 1200));
  await flush();
  expect(mockRasterize).not.toHaveBeenCalled();
});

it('does not pause the PDF page for a typed pre-dispatch failure', async () => {
  mockRasterize.mockRejectedValueOnce(new PdfRenderNotStartedError('checkpoint unavailable'));
  await renderHook(() => usePdfDetails([map], [overview], bounds, 1200));
  await flush();
  expect(mockPauseFailedPage).not.toHaveBeenCalled();
});

describe("backoff for failures that are not the page's fault (#382)", () => {
  const reportError = jest.requireMock<{ reportError: jest.Mock }>(
    '@lib/errorReporting',
  ).reportError;
  const shifted = (i: number) => ({
    ...bounds,
    west: bounds.west + i * 0.03,
    east: bounds.east + i * 0.03,
  });
  const lastTileKey = () =>
    (mockPlans.mock.results.at(-1)?.value as { tileKey: string }[] | undefined)?.[0]?.tileKey;
  const detailLine = () => renderStatusLine(map, useOverlayStatusStore.getState().statuses)?.text;
  async function mountPanning(maps: MapDocument[] = [map]) {
    // One tile per camera position, keyed by it: every pan plans a new tile.
    mockPlans.mockImplementation((_corners: unknown, _size: unknown, b: typeof bounds) => [
      tile(`west${b.west.toFixed(3)}`, 0.25),
    ]);
    const view = await renderHook(
      ({ b, m }: { b: typeof bounds; m: MapDocument[] }) => usePdfDetails(m, [overview], b, 1200),
      { initialProps: { b: bounds, m: maps } },
    );
    await flush();
    let step = 0;
    const pan = async (m: MapDocument[] = maps) => {
      step += 1;
      const before = lastTileKey();
      await view.rerender({ b: shifted(step), m });
      // Every pan in these tests is a camera change the worker must see.
      expect(lastTileKey()).not.toBe(before);
      await flush();
    };
    return { view, pan };
  }

  it('sits a not-started page out on every pan instead of retrying and reporting each time', async () => {
    mockRasterize.mockRejectedValue(new PdfRenderNotStartedError('PdfRasterizer: engine busy'));
    const { view, pan } = await mountPanning();
    expect(mockRasterize).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledTimes(1);

    // The 677-reports pattern: a burst of camera changes inside the window.
    for (let i = 0; i < 5; i++) await pan();
    expect(mockRasterize).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(detailLine()).toBe("Couldn't render page 1 detail: PdfRasterizer: engine busy");
    expect(mockPauseFailedPage).not.toHaveBeenCalled();

    // The 2 s window is over: one attempt, which fails again — not re-reported.
    await act(async () => jest.advanceTimersByTime(500));
    await pan();
    expect(mockRasterize).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledTimes(1);

    // Now it waits 4 s.
    await act(async () => jest.advanceTimersByTime(3_000));
    await pan();
    expect(mockRasterize).toHaveBeenCalledTimes(2);
    await act(async () => jest.advanceTimersByTime(1_000));
    await pan();
    expect(mockRasterize).toHaveBeenCalledTimes(3);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(mockPauseFailedPage).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('reports a different failure at once, and starts over after a success', async () => {
    mockRasterize
      .mockRejectedValueOnce(new PdfRenderNotStartedError('engine busy'))
      .mockRejectedValueOnce(new PdfRenderNotStartedError('checkpoint unavailable'))
      .mockResolvedValueOnce(raster)
      .mockRejectedValueOnce(new PdfRenderNotStartedError('checkpoint unavailable'));
    const { view, pan } = await mountPanning();
    await act(async () => jest.advanceTimersByTime(2_000));
    await pan();
    expect(reportError).toHaveBeenCalledTimes(2);
    await act(async () => jest.advanceTimersByTime(4_000));
    await pan();
    expect(mockRasterize).toHaveBeenCalledTimes(3);
    expect(detailLine()).toBeUndefined();
    // Success cleared the record: the very next failure is reported, and the
    // wait is back to the base 2 s, not 8 s.
    await pan();
    expect(mockRasterize).toHaveBeenCalledTimes(4);
    expect(reportError).toHaveBeenCalledTimes(3);
    await act(async () => jest.advanceTimersByTime(2_000));
    await pan();
    expect(mockRasterize).toHaveBeenCalledTimes(5);
    await view.unmount();
  });

  it('retries at once when the page gets a new revision', async () => {
    mockRasterize
      .mockRejectedValueOnce(new PdfRenderNotStartedError('engine busy'))
      .mockResolvedValue(raster);
    const { view, pan } = await mountPanning();
    await pan();
    expect(mockRasterize).toHaveBeenCalledTimes(1);
    await pan([{ ...map, importedAt: 2 }]);
    expect(mockRasterize).toHaveBeenCalledTimes(2);
    expect(view.result.current).toHaveLength(1);
    await view.unmount();
  });

  it('keeps quarantining real render failures rather than backing them off', async () => {
    mockRasterize.mockRejectedValueOnce(new Error('render timed out after 45000ms'));
    const { view } = await mountPanning();
    expect(mockPauseFailedPage).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('fails an empty inline read as a preparation error before rasterizing', async () => {
    mockServerOrigin.mockResolvedValue(null);
    mockFileSize.mockReturnValue(1_234);
    mockReadBase64.mockResolvedValue('');
    const { view, pan } = await mountPanning();
    const reason = 'Could not read maps/map.pdf for rendering (0 bytes read, 1234 B on disk)';
    expect(mockRasterize).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]?.[0]).toMatchObject({ message: reason });
    expect(reportError.mock.calls[0]?.[1]).toBe('pdf-detail-render');
    expect(detailLine()).toBe(`Couldn't render page 1 detail: ${reason}`);
    await pan();
    expect(mockReadBase64).toHaveBeenCalledTimes(1);
    expect(mockPauseFailedPage).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('still renders a small file inline when the server is unavailable', async () => {
    mockServerOrigin.mockResolvedValue(null);
    mockFileSize.mockReturnValue(1_234);
    mockReadBase64.mockResolvedValue('JVBERi0=');
    const { view } = await mountPanning();
    expect(mockRasterize.mock.calls[0]?.[0]).toMatchObject({ source: { base64: 'JVBERi0=' } });
    expect(view.result.current).toHaveLength(1);
    await view.unmount();
  });
});

it("renders tiles at the overview's see-through level and never shows them for another", async () => {
  const keyed: PdfOverlay = { ...overview, imageUri: 'file://overview-100', whiteKey: 4 };
  const v = await renderHook(
    ({ o }: { o: PdfOverlay }) => usePdfDetails([map], [o], bounds, 1200),
    { initialProps: { o: keyed } },
  );
  await flush();
  expect(mockRasterize.mock.calls[0]?.[0]).toMatchObject({ whiteKey: 4 });
  expect(v.result.current).toHaveLength(1);

  // The overview switches back to Off: the 100 % tile must not linger over it,
  // and its replacement is rendered unkeyed.
  await v.rerender({ o: { ...overview, whiteKey: 0 } });
  expect(v.result.current).toEqual([]);
  await flush();
  expect(mockRasterize.mock.calls.at(-1)?.[0]).toMatchObject({ whiteKey: 0 });
  expect(v.result.current).toHaveLength(1);
  await v.unmount();
});

describe('reusing rendered detail across zooms and pans', () => {
  const toMercator = pageToMercator(overview.coordinates);
  const geoAt = (u: number, v: number): [number, number] => {
    const [x, y] = toMercator(u, v);
    return [(x * 180) / Math.PI, ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI];
  };
  /** A real dyadic grid cell of the test page (corners -71..-70, 47..46). */
  const cell = (divisions: number, x: number, y: number, width: number, prefetch = false) => {
    const u0 = x / divisions,
      u1 = (x + 1) / divisions,
      v0 = y / divisions,
      v1 = (y + 1) / divisions;
    return {
      tileKey: `${divisions}:${x}:${y}:${width}`,
      crop: { x0: u0, y0: v0, x1: u1, y1: v1 },
      targetWidthPx: width,
      // Placed the way the planner places cells: the page mapping in Mercator.
      coordinates: [geoAt(u0, v0), geoAt(u1, v0), geoAt(u1, v1), geoAt(u0, v1)],
      ...(prefetch ? { prefetch: true as const } : {}),
    } as PdfDetailPlan;
  };
  // The camera (`bounds`) sits over cell 8:3:4; these are its four children.
  const children = (width: number) => [
    cell(16, 6, 8, width),
    cell(16, 7, 8, width),
    cell(16, 6, 9, width),
    cell(16, 7, 9, width),
  ];
  const ids = (details: PdfOverlay[]) => details.map((d) => d.id);
  const zoomedOut = { west: -70.7, east: -70.4, north: 46.6, south: 46.3 };

  it('keeps the sharper tiles on screen through a zoom-out until the coarser one lands', async () => {
    mockPlans.mockReturnValue(children(512));
    const v = await renderHook(
      ({ b }: { b: typeof bounds }) => usePdfDetails([map], [overview], b, 1200),
      { initialProps: { b: bounds } },
    );
    await flush();
    // The four children render as one 2x2 block: one call, one texture.
    expect(ids(v.result.current)).toEqual(['map:0:tile:16:6:8:512:2x2']);
    const sharp = new Set(ids(v.result.current));
    let land!: (value: typeof raster) => void;
    mockRasterize.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          land = resolve;
        }),
    );
    // Zoomed out a level, and wider than the children can stand in for.
    mockPlans.mockReturnValue([cell(8, 3, 4, 1280)]);
    await v.rerender({ b: zoomedOut });
    // Never back to the bare (blurry) overview while the replacement renders.
    expect(new Set(ids(v.result.current))).toEqual(sharp);
    await flush();
    expect(mockRasterize).toHaveBeenCalledTimes(2);
    expect(new Set(ids(v.result.current))).toEqual(sharp);
    await act(async () => {
      land(raster);
    });
    // The parent covers every child: they go, it alone remains.
    expect(ids(v.result.current)).toEqual(['map:0:tile:8:3:4:1280']);
    await v.unmount();
    expect(mockFiles.size).toBe(0);
  });

  it('shows the four children for a whole-level zoom-out instead of rendering the parent', async () => {
    mockPlans.mockReturnValue(children(512));
    const v = await renderHook(
      ({ b }: { b: typeof bounds }) => usePdfDetails([map], [overview], b, 1200),
      { initialProps: { b: bounds } },
    );
    await flush();
    const sharp = new Set(ids(v.result.current));
    mockPlans.mockReturnValue([cell(8, 3, 4, 1024)]);
    await v.rerender({ b: zoomedOut });
    await flush();
    // The children's block stands in for the parent: nothing is rendered.
    expect(mockRasterize).toHaveBeenCalledTimes(1);
    expect(new Set(ids(v.result.current))).toEqual(sharp);
    await v.unmount();
  });

  it('never lets stand-in children crowd a rendered tile out of the visible budget', async () => {
    // 1 Mi-pixel rasters: four children stand in for one parent at 4 Mi.
    mockRasterize.mockResolvedValue({ ...raster, widthPx: 1024, heightPx: 1024 });
    mockPlans.mockReturnValue(children(512));
    const v = await renderHook(
      ({ b }: { b: typeof bounds }) => usePdfDetails([map], [overview], b, 1200),
      { initialProps: { b: bounds } },
    );
    await flush();
    expect(mockRasterize).toHaveBeenCalledTimes(1);
    // Zoomed out: the covered parent first, then three cells that must render.
    // Children (4 Mi) + three tiles (3 Mi) exceed the 6 Mi visible budget.
    const parents = [cell(8, 3, 4, 1024), cell(8, 2, 4, 1024), cell(8, 4, 4, 1024)];
    mockPlans.mockReturnValue([...parents, cell(8, 3, 3, 1024), cell(8, 5, 4, 1024, true)]);
    await v.rerender({ b: zoomedOut });
    await flush();
    // Everything the view needs renders before the neighbour ring starts.
    const order = mockRasterize.mock.calls.slice(1).map(([args]) => args.priority);
    expect(order.length).toBeGreaterThan(1);
    expect(order[order.length - 1]).toBe('background');
    expect(order.slice(0, -1).every((p) => p === 'interactive')).toBe(true);
    // Every requested tile ends up on screen within the visible budget.
    for (const key of ['8:3:4:1024', '8:2:4:1024', '8:4:4:1024', '8:3:3:1024'])
      expect(heldBy(v.result.current, key)).toBeDefined();
    await v.unmount();
  });

  it('shows the wider raster of the same cell after a small zoom-out', async () => {
    mockPlans.mockReturnValue([cell(8, 3, 4, 1024)]);
    const v = await renderHook(
      ({ b }: { b: typeof bounds }) => usePdfDetails([map], [overview], b, 1200),
      { initialProps: { b: bounds } },
    );
    await flush();
    const [wide] = v.result.current;
    mockPlans.mockReturnValue([cell(8, 3, 4, 768)]);
    await v.rerender({ b: { ...bounds, west: bounds.west - 0.005, east: bounds.east + 0.005 } });
    expect(v.result.current).toEqual([wide]);
    await flush();
    expect(mockRasterize).toHaveBeenCalledTimes(1);
    // Zooming back in past it renders the sharper width, which then wins.
    mockPlans.mockReturnValue([cell(8, 3, 4, 1280)]);
    await v.rerender({ b: { ...bounds, west: bounds.west + 0.005, east: bounds.east - 0.005 } });
    await flush();
    expect(mockRasterize).toHaveBeenCalledTimes(2);
    expect(ids(v.result.current)).toEqual(['map:0:tile:8:3:4:1280']);
    await v.unmount();
  });

  it('keeps a zoom-in’s coarse tile on screen while the sharper ones render', async () => {
    mockPlans.mockReturnValue([cell(8, 3, 4, 768)]);
    const v = await renderHook(
      ({ b }: { b: typeof bounds }) => usePdfDetails([map], [overview], b, 1200),
      { initialProps: { b: bounds } },
    );
    await flush();
    const coarse = ids(v.result.current);
    mockRasterize.mockImplementation(() => new Promise(() => undefined));
    mockPlans.mockReturnValue(children(768));
    await v.rerender({ b: { west: -70.59, east: -70.51, north: 46.49, south: 46.41 } });
    await flush();
    expect(ids(v.result.current)).toEqual(coarse);
    await v.unmount();
  });

  it('renders the neighbour ring after the view, in the background, without showing it', async () => {
    const phases: string[] = [];
    const unsubscribe = useOverlayStatusStore.subscribe((state) => {
      for (const status of Object.values(state.statuses)) phases.push(status.phase);
    });
    mockPlans.mockReturnValue([cell(8, 3, 4, 768), cell(8, 4, 4, 768, true)]);
    const v = await renderHook(() => usePdfDetails([map], [overview], bounds, 1200));
    await flush();
    expect(
      mockRasterize.mock.calls.map(([args]) => [args.crop.x0, args.priority, args.holdKey]),
    ).toEqual([
      [3 / 8, 'interactive', 'maps/map.pdf@1'],
      [4 / 8, 'background', 'maps/map.pdf@1'],
    ]);
    expect(ids(v.result.current)).toEqual(['map:0:tile:8:3:4:768']);
    // One "rendering" for the visible tile; the ring adds none.
    expect(phases.filter((phase) => phase === 'rendering')).toHaveLength(1);
    unsubscribe();
    await v.unmount();
  });

  it('never fails, pauses or reports the page for a failing neighbour', async () => {
    const { reportError } = jest.requireMock<{ reportError: jest.Mock }>('@lib/errorReporting');
    reportError.mockClear();
    mockRasterize.mockResolvedValueOnce(raster).mockRejectedValueOnce(new Error('ring failed'));
    mockPlans.mockReturnValue([cell(8, 3, 4, 768), cell(8, 4, 4, 768, true)]);
    const v = await renderHook(
      ({ b }: { b: typeof bounds }) => usePdfDetails([map], [overview], b, 1200),
      { initialProps: { b: bounds } },
    );
    await flush();
    expect(ids(v.result.current)).toEqual(['map:0:tile:8:3:4:768']);
    expect(reportError).not.toHaveBeenCalled();
    expect(mockPauseFailedPage).not.toHaveBeenCalled();
    expect(useOverlayStatusStore.getState().statuses['map:0:detail']?.phase).not.toBe('failed');
    // No backoff either: panning onto that cell renders it at once.
    mockPlans.mockReturnValue([cell(8, 3, 4, 768), cell(8, 4, 4, 768)]);
    await v.rerender({ b: { ...bounds, east: bounds.east + 0.05 } });
    await flush();
    expect(new Set(ids(v.result.current))).toEqual(
      new Set(['map:0:tile:8:3:4:768', 'map:0:tile:8:4:4:768']),
    );
    expect(useOverlayStatusStore.getState().statuses['map:0:detail']?.phase).not.toBe('failed');
    await v.unmount();
  });

  it('stops prefetching after a memory warning', async () => {
    const listeners: (() => void)[] = [];
    const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation((type, listener) => {
      if (type === 'memoryWarning') listeners.push(listener as () => void);
      return { remove: () => undefined } as ReturnType<typeof AppState.addEventListener>;
    });
    mockPlans.mockReturnValue([cell(8, 3, 4, 768)]);
    const v = await renderHook(() => usePdfDetails([map], [overview], bounds, 1200));
    await flush();
    expect(mockPlans.mock.calls.at(-1)?.[6]).toEqual({
      prefetchMargin: BUDGETS.prefetchMargin,
      maxPrefetch: BUDGETS.maxPrefetchTiles,
    });
    expect(mockRasterize.mock.calls.at(-1)?.[0].holdKey).toEqual(expect.any(String));
    expect(listeners).toHaveLength(1);
    await act(async () => listeners[0]!());
    expect(mockPlans.mock.calls.at(-1)?.[6]).toEqual({ prefetchMargin: 0, maxPrefetch: 0 });
    expect(v.result.current).toHaveLength(1);
    // Nor does the renderer keep the document open between tiles any more.
    mockPlans.mockReturnValue([cell(8, 4, 4, 768)]);
    await v.rerender({});
    await flush();
    expect(mockRasterize).toHaveBeenCalledTimes(2);
    expect(mockRasterize.mock.calls.at(-1)?.[0].holdKey).toBeUndefined();
    spy.mockRestore();
    await v.unmount();
  });
});
