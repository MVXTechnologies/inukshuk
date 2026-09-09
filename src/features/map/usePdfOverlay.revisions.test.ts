import { PdfRenderNotStartedError } from './pdfRenderFailure';
import { migrateLibraryIndex } from '@core/library/migrations';
import { visibleMaps } from '@core/library/visibility';
import type { GeoReference, MapDocument } from '@core/models';
import { act, renderHook } from '@testing-library/react-native';
import type { RasterResult } from './PdfRasterizer';
import { usePdfOverlays } from './usePdfOverlay';

const mockFiles = new Map<string, string>();
const mockRasterize = jest.fn(
  async ({ source }: { source: { base64: string } }): Promise<RasterResult> => ({
    pngDataUri: `data:image/png;base64,${source.base64}`,
    widthPx: 2048,
    heightPx: 2048,
    pageWidthPt: 100,
    pageHeightPt: 100,
    pageCount: 1,
    loadMs: 1,
    renderMs: 1,
  }),
);
let mockCurrentRasterize = mockRasterize;
const mockServerOrigin = jest.fn(async (): Promise<string | null> => null);
jest.mock('./PdfRasterizer', () => ({
  usePdfRasterizer: () => mockCurrentRasterize,
  usePdfRasterizerServer: () => mockServerOrigin,
}));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));
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
jest.mock('@data/storage', () => ({
  resolveDocumentPath: (uri: string) => uri,
  adoptOverlayPng: (id: string, source: string) => {
    const uri = `file://cache/${id}.png`;
    mockFiles.set(uri, mockFiles.get(source) ?? '');
    mockFiles.delete(source);
    return uri;
  },
  toDocumentPath: (uri: string) => uri.replace('file://documents/', ''),
  fileSizeAt: () => 10,
  readFileBase64: async (uri: string) => (uri.endsWith('new.pdf') ? 'NEW' : 'OLD'),
  existingOverlayPng: (id: string) =>
    mockFiles.get(`file://cache/${id}.png`) ? `file://cache/${id}.png` : null,
  writeOverlayPng: (id: string, content: string) => {
    const uri = `file://cache/${id}.png`;
    mockFiles.set(uri, content);
    return uri;
  },
}));

const geo: GeoReference = {
  pageIndex: 0,
  source: 'adobe-geo',
  pageWidthPt: 100,
  pageHeightPt: 100,
  viewport: {
    rect: { x0: 0, y0: 0, x1: 100, y1: 100 },
    corners: {
      topLeft: [-71, 47],
      topRight: [-70, 47],
      bottomRight: [-70, 46],
      bottomLeft: [-71, 46],
    },
  },
  bbox: { minLat: 46, maxLat: 47, minLng: -71, maxLng: -70 },
};
const map: MapDocument = {
  id: 'revision-test',
  name: 'Sheet',
  fileUri: 'file://documents/maps/old.pdf',
  importedAt: 1,
  pageCount: 1,
  activePages: [0],
  georeferences: [geo],
};

beforeEach(() => {
  mockFiles.clear();
  mockCurrentRasterize = mockRasterize;
  mockServerOrigin.mockReset().mockResolvedValue(null);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

it('replaces an active catalog map raster when the file changes under the same library id', async () => {
  const view = await renderHook(({ maps }: { maps: MapDocument[] }) => usePdfOverlays(maps), {
    initialProps: { maps: [map] },
  });
  const firstUri = view.result.current.overlays[0]?.imageUri;
  expect(mockFiles.get(firstUri ?? '')).toBe('OLD');
  await act(async () => {
    await view.rerender({
      maps: [{ ...map, fileUri: 'file://documents/maps/new.pdf', importedAt: 2 }],
    });
  });
  const nextUri = view.result.current.overlays[0]?.imageUri;
  expect(mockFiles.get(nextUri ?? '')).toBe('NEW');
  expect(nextUri).not.toBe(firstUri);
});

it('repositions a cached page when only georeferencing changes', async () => {
  const view = await renderHook(({ maps }: { maps: MapDocument[] }) => usePdfOverlays(maps), {
    initialProps: { maps: [map] },
  });
  const firstUri = view.result.current.overlays[0]?.imageUri;
  const moved: GeoReference = {
    ...geo,
    viewport: {
      ...geo.viewport,
      corners: {
        topLeft: [-61, 47],
        topRight: [-60, 47],
        bottomRight: [-60, 46],
        bottomLeft: [-61, 46],
      },
    },
  };
  await view.rerender({ maps: [{ ...map, georeferences: [moved] }] });
  expect(view.result.current.overlays[0]?.coordinates[0]).toEqual([-61, 47]);
  expect(view.result.current.overlays[0]?.imageUri).toBe(firstUri);
  expect(mockRasterize).toHaveBeenCalledTimes(1);
});

it('publishes a ready overview while another active document is still rendering', async () => {
  let finish!: (value: Awaited<ReturnType<typeof mockRasterize>>) => void;
  const ready = { ...map, id: 'ready-overview' };
  const slow = { ...map, id: 'slow-overview' };
  const raster = {
    pngDataUri: 'data:image/png;base64,READY',
    widthPx: 2048,
    heightPx: 2048,
    pageWidthPt: 100,
    pageHeightPt: 100,
    pageCount: 1,
    loadMs: 1,
    renderMs: 1,
  };
  mockRasterize.mockResolvedValueOnce(raster).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = await renderHook(() => usePdfOverlays([ready, slow]));
  expect(view.result.current.overlays.map((o) => o.id)).toEqual(['ready-overview:0']);
  expect(view.result.current.loading).toBe(true);
  await act(async () => finish(raster));
  expect(view.result.current.overlays).toHaveLength(2);
});

it('shares an unfinished page render when the active document set changes', async () => {
  let finish!: (value: Awaited<ReturnType<typeof mockRasterize>>) => void;
  const pending = { ...map, id: 'pending-overview' };
  const extra = { ...map, id: 'extra-overview' };
  const raster = {
    pngDataUri: 'data:image/png;base64,SHARED',
    widthPx: 2048,
    heightPx: 2048,
    pageWidthPt: 100,
    pageHeightPt: 100,
    pageCount: 1,
    loadMs: 1,
    renderMs: 1,
  };
  mockRasterize.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = await renderHook(({ maps }: { maps: MapDocument[] }) => usePdfOverlays(maps), {
    initialProps: { maps: [pending] },
  });
  await view.rerender({ maps: [pending, extra] });
  expect(mockRasterize).toHaveBeenCalledTimes(1);
  await act(async () => finish(raster));
  expect(view.result.current.overlays.map((o) => o.id)).toEqual([
    'pending-overview:0',
    'extra-overview:0',
  ]);
  expect(mockRasterize).toHaveBeenCalledTimes(2);
});

it('shows a cached page even when a newly activated slow document comes first', async () => {
  const cached = { ...map, id: 'cached-behind-slow' };
  const slow = { ...map, id: 'new-slow-first' };
  const view = await renderHook(({ maps }: { maps: MapDocument[] }) => usePdfOverlays(maps), {
    initialProps: { maps: [cached] },
  });
  await view.rerender({ maps: [] });
  let finish!: (value: Awaited<ReturnType<typeof mockRasterize>>) => void;
  mockRasterize.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await view.rerender({ maps: [slow, cached] });
  expect(view.result.current.overlays.map((o) => o.id)).toEqual(['cached-behind-slow:0']);
  expect(view.result.current.loading).toBe(true);
  await act(async () =>
    finish({
      pngDataUri: 'data:image/png;base64,SLOW',
      widthPx: 2048,
      heightPx: 2048,
      pageWidthPt: 100,
      pageHeightPt: 100,
      pageCount: 1,
      loadMs: 1,
      renderMs: 1,
    }),
  );
  expect(view.result.current.overlays.map((o) => o.id)).toEqual([
    'new-slow-first:0',
    'cached-behind-slow:0',
  ]);
});

it('requests native geometry without changing the full-page fallback and caches the native file', async () => {
  const nativeMap = { ...map, id: 'native-overview' };
  mockFiles.set('file://cache/pdf-detail-native.png', 'NATIVE PNG');
  mockRasterize.mockResolvedValueOnce({
    fileUri: 'file://cache/pdf-detail-native.png',
    widthPx: 1773,
    heightPx: 1773,
    pageWidthPt: 100,
    pageHeightPt: 100,
    pageCount: 1,
    loadMs: 1,
    renderMs: 1,
  });
  const view = await renderHook(() => usePdfOverlays([nativeMap]));
  expect(mockRasterize).toHaveBeenCalledWith(
    expect.objectContaining({
      nativePage: {
        fileUri: nativeMap.fileUri,
        revision: expect.any(String),
        expectedPageWidthPt: 100,
        expectedPageHeightPt: 100,
      },
    }),
  );
  expect(mockRasterize.mock.calls[0]?.[0]).not.toHaveProperty('crop');
  const uri = view.result.current.overlays[0]?.imageUri;
  expect(uri).toMatch(/native-overview_.*_0_2048.png$/);
  expect(mockFiles.get(uri ?? '')).toBe('NATIVE PNG');
  expect(mockFiles.has('file://cache/pdf-detail-native.png')).toBe(false);
  await view.unmount();
  const remounted = await renderHook(() => usePdfOverlays([nativeMap]));
  expect(remounted.result.current.overlays[0]?.imageUri).toBe(uri);
  expect(mockRasterize).toHaveBeenCalledTimes(1);
});

it('places a cropped page on its rendered box and keeps it off the native path (#287)', async () => {
  // /MediaBox [0 0 200 100] /CropBox [50 25 150 75], the map frame being the
  // whole crop: the overlay must span exactly the frame's corners (pdf.js
  // renders the 100×50 pt crop), and native rendering — which only takes a
  // zero-origin page — must not be offered at all.
  const cropped: MapDocument = {
    ...map,
    id: 'cropped-page',
    georeferences: [
      {
        ...geo,
        pageWidthPt: 100,
        pageHeightPt: 50,
        pageBox: { x0: 50, y0: 25, x1: 150, y1: 75 },
        viewport: { ...geo.viewport, rect: { x0: 50, y0: 25, x1: 150, y1: 75 } },
      },
    ],
  };
  const view = await renderHook(() => usePdfOverlays([cropped]));
  expect(mockRasterize).toHaveBeenCalledWith(expect.objectContaining({ nativePage: null }));
  expect(view.result.current.overlays[0]?.coordinates).toEqual([
    [-71, 47],
    [-70, 47],
    [-70, 46],
    [-71, 46],
  ]);
  await view.unmount();
});

it('keeps the pre-#287 zero-origin placement for a document with no page box', async () => {
  // The same cropped frame as persisted by an older build: MediaBox size and
  // no box. It draws where it always did (the audit's doubled extent) and is
  // flagged in the log; only a re-import can correct it.
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  const legacy: MapDocument = {
    ...map,
    id: 'legacy-page',
    georeferences: [
      {
        ...geo,
        pageWidthPt: 200,
        pageHeightPt: 100,
        viewport: { ...geo.viewport, rect: { x0: 50, y0: 25, x1: 150, y1: 75 } },
      },
    ],
  };
  const view = await renderHook(() => usePdfOverlays([legacy]));
  expect(view.result.current.overlays[0]?.coordinates).toEqual([
    [-71.5, 47.5],
    [-69.5, 47.5],
    [-69.5, 45.5],
    [-71.5, 45.5],
  ]);
  expect(mockRasterize).toHaveBeenCalledWith(
    expect.objectContaining({
      nativePage: expect.objectContaining({ expectedPageWidthPt: 200, expectedPageHeightPt: 100 }),
    }),
  );
  expect(log).toHaveBeenCalledWith(expect.stringContaining('re-import to reprocess'));
  log.mockRestore();
  await view.unmount();
});

it('does not inherit an unresolved render from a replaced provider', async () => {
  const pendingMap = { ...map, id: 'replaced-provider' };
  mockServerOrigin.mockImplementationOnce(() => new Promise(() => undefined));
  const first = await renderHook(() => usePdfOverlays([pendingMap]));
  expect(first.result.current.loading).toBe(true);
  expect(mockRasterize).not.toHaveBeenCalled();
  await first.unmount();
  const replacement = jest.fn(mockRasterize);
  mockCurrentRasterize = replacement;
  const second = await renderHook(() => usePdfOverlays([pendingMap]));
  expect(replacement).toHaveBeenCalledTimes(1);
  expect(second.result.current.overlays).toHaveLength(1);
  expect(second.result.current.loading).toBe(false);
});

it('does not schedule hidden PDF overviews and reuses completed cache when shown again', async () => {
  const target = { ...map, id: 'visibility-gate' };
  const view = await renderHook(
    ({ enabled }: { enabled: boolean }) => usePdfOverlays([target], enabled),
    { initialProps: { enabled: false } },
  );
  expect(mockRasterize).not.toHaveBeenCalled();
  expect(mockServerOrigin).not.toHaveBeenCalled();
  expect(view.result.current).toEqual({ overlays: [], loading: false, error: null });
  await view.rerender({ enabled: true });
  const uri = view.result.current.overlays[0]?.imageUri;
  expect(mockRasterize).toHaveBeenCalledTimes(1);
  await view.rerender({ enabled: false });
  expect(view.result.current).toEqual({ overlays: [], loading: false, error: null });
  await view.rerender({ enabled: true });
  expect(view.result.current.overlays[0]?.imageUri).toBe(uri);
  expect(mockRasterize).toHaveBeenCalledTimes(1);
});

it('does not enqueue a prepared source after PDFs are hidden', async () => {
  let finish!: (origin: string | null) => void;
  mockServerOrigin.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = await renderHook(
    ({ enabled }: { enabled: boolean }) =>
      usePdfOverlays([{ ...map, id: 'hide-during-startup' }], enabled),
    { initialProps: { enabled: true } },
  );
  expect(view.result.current.loading).toBe(true);
  await view.rerender({ enabled: false });
  await act(async () => finish(null));
  expect(mockRasterize).not.toHaveBeenCalled();
  expect(view.result.current).toEqual({ overlays: [], loading: false, error: null });
  await view.rerender({ enabled: true });
  expect(mockRasterize).toHaveBeenCalledTimes(1);
  expect(view.result.current.overlays).toHaveLength(1);
});

it('restores every active page after restart regardless of the selected map', async () => {
  const restored = migrateLibraryIndex({
    maps: [
      { ...map, id: 'large-first' },
      { ...map, id: 'selected-small' },
    ],
    activeMapId: 'selected-small',
  });
  const shown = visibleMaps(restored.mapVisibilityMode, restored.visibleFolderIds, restored.maps);
  expect(shown.map((m) => [m.id, m.activePages])).toEqual([
    ['large-first', [0]],
    ['selected-small', [0]],
  ]);
  const view = await renderHook(() => usePdfOverlays(shown, false));
  expect(view.result.current.overlays).toEqual([]);
  expect(mockRasterize).not.toHaveBeenCalled();
});

it('keeps a render that finishes while hidden in cache without starting the next map', async () => {
  let finish!: (value: RasterResult) => void;
  mockRasterize.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const targets = [
    { ...map, id: 'hide-running' },
    { ...map, id: 'hide-waiting' },
  ];
  const view = await renderHook(
    ({ enabled }: { enabled: boolean }) => usePdfOverlays(targets, enabled),
    { initialProps: { enabled: true } },
  );
  await view.rerender({ enabled: false });
  await act(async () =>
    finish({
      pngDataUri: 'data:image/png;base64,DONE',
      widthPx: 2048,
      heightPx: 2048,
      pageWidthPt: 100,
      pageHeightPt: 100,
      pageCount: 1,
      loadMs: 1,
      renderMs: 1,
    }),
  );
  expect(view.result.current).toEqual({ overlays: [], loading: false, error: null });
  expect(mockRasterize).toHaveBeenCalledTimes(1);
  await view.rerender({ enabled: true });
  expect(view.result.current.overlays).toHaveLength(2);
  expect(mockRasterize).toHaveBeenCalledTimes(2);
});

it('rerenders a previously cached overview when its persisted file becomes empty', async () => {
  const target = { ...map, id: 'invalid-memory-hit' };
  const first = await renderHook(() => usePdfOverlays([target]));
  const uri = first.result.current.overlays[0]!.imageUri;
  await first.unmount();
  mockFiles.set(uri, '');
  const second = await renderHook(() => usePdfOverlays([target]));
  expect(mockRasterize).toHaveBeenCalledTimes(2);
  expect(mockFiles.get(second.result.current.overlays[0]!.imageUri)).toBe('OLD');
});

const mockPauseFailedOverview = jest.fn();
jest.mock('@state/libraryStore', () => ({
  useLibraryStore: {
    getState: () => ({ pauseMapPageAfterRenderFailure: mockPauseFailedOverview }),
  },
}));
beforeEach(() => mockPauseFailedOverview.mockClear());
it('pauses only an overview whose dispatched render failed', async () => {
  mockRasterize.mockRejectedValueOnce(new Error('PdfRasterizer: rendering process terminated'));
  await renderHook(() => usePdfOverlays([{ ...map, id: 'caught-overview' }]));
  expect(mockPauseFailedOverview).toHaveBeenCalledWith(
    'caught-overview',
    0,
    'PdfRasterizer: rendering process terminated',
    { fileUri: map.fileUri, importedAt: map.importedAt },
  );
});
it('does not pause an overview for a failure before raster dispatch', async () => {
  mockServerOrigin.mockRejectedValueOnce(new Error('server unavailable'));
  await renderHook(() => usePdfOverlays([{ ...map, id: 'before-dispatch' }]));
  expect(mockPauseFailedOverview).not.toHaveBeenCalled();
});

it('does not pause the PDF page for a typed pre-dispatch failure', async () => {
  mockRasterize.mockRejectedValueOnce(new PdfRenderNotStartedError('checkpoint unavailable'));
  await renderHook(() => usePdfOverlays([{ ...map, id: 'admission-failure' }]));
  expect(mockPauseFailedOverview).not.toHaveBeenCalled();
});
