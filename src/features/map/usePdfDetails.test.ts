import { act, renderHook } from '@testing-library/react-native';
import { usePdfDetails } from './usePdfDetails';
import type { MapDocument } from '@core/models';
import type { PdfOverlay } from './usePdfOverlay';

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
});
afterEach(() => jest.useRealTimers());

it('refines a large PDF over the served path and retains the overview on failure', async () => {
  const v = await renderHook(() => usePdfDetails([map], [overview], bounds, 1200));
  await flush();
  expect(v.result.current[0]?.imageUri).toBeDefined();
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
    expect(mockFiles.size).toBeLessThanOrEqual(6);
    expect(mockFiles.has(v.result.current[0]!.imageUri)).toBe(true);
  }
  await act(async () => {
    jest.advanceTimersByTime(2000);
  });
  expect(mockFiles.size).toBeLessThanOrEqual(4);
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
