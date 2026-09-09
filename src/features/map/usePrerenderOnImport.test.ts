// The import-time pre-render worker (#272 step 2): every import path lands a
// document in the library store, and every active georeferenced page of it
// must reach the rasterizer at background priority and end up in the file the
// overlay hook reads — without a toast, and without ever running while the
// app is in the background.
import { documentRevision, rasterFileName } from '@core/library/overlayRaster';
import { renderStatusLine } from '@core/library/overlayStatus';
import { PRERENDER_MAX_ATTEMPTS } from '@core/library/prerenderQueue';
import { renderingToasts } from '@core/library/renderingToasts';
import type { GeoReference, MapDocument } from '@core/models';
import { reportError } from '@lib/errorReporting';
import { useLibraryStore } from '@state/libraryStore';
import { useOverlayStatusStore } from '@state/overlayStatusStore';
import { act, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import type { RasterizeArgs, RasterResult } from './PdfRasterizer';
import { PdfRenderNotStartedError } from './pdfRenderFailure';
import { pendingRastersFor } from './usePdfOverlay';
import { usePrerenderOnImport } from './usePrerenderOnImport';

const mockFiles = new Map<string, string>();
const result = (source: RasterizeArgs['source']): RasterResult => ({
  pngDataUri: `data:image/png;base64,${source.base64 ?? source.url}`,
  widthPx: 2048,
  heightPx: 2048,
  pageWidthPt: 100,
  pageHeightPt: 100,
  pageCount: 1,
  loadMs: 1,
  renderMs: 1,
});
const mockRasterize = jest.fn(async (args: RasterizeArgs): Promise<RasterResult> =>
  result(args.source),
);
const mockServerOrigin = jest.fn(async (): Promise<string | null> => null);
jest.mock('./PdfRasterizer', () => ({
  usePdfRasterizer: () => mockRasterize,
  usePdfRasterizerServer: () => mockServerOrigin,
}));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));
jest.mock('@data/pdfRenderRecovery', () => ({
  readInterruptedPdfRender: jest.fn(() => null),
  clearInterruptedPdfRender: jest.fn(),
  protectInterruptedPdfRender: jest.fn(),
}));
jest.mock('expo-file-system', () => ({ File: class {} }));
jest.mock('@data/storage', () => ({
  ...jest
    .requireActual<typeof import('@data/storageTestMock')>('@data/storageTestMock')
    .documentPathMocks(),
  ensureStorage: jest.fn(),
  readIndex: jest.fn(),
  writeIndex: jest.fn(),
  deleteFileAt: jest.fn(),
  fileSizeAt: () => 10,
  readFileBase64: async (uri: string) => uri.slice(uri.lastIndexOf('/') + 1),
  existingOverlayPng: (id: string) =>
    mockFiles.has(`file://cache/${id}.png`) ? `file://cache/${id}.png` : null,
  writeOverlayPng: (id: string, content: string) => {
    const uri = `file://cache/${id}.png`;
    mockFiles.set(uri, content);
    return uri;
  },
  adoptOverlayPng: jest.fn(),
}));

const geo = (pageIndex: number): GeoReference => ({
  pageIndex,
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
});
const sheet = (id: string, pages = 1): MapDocument => ({
  id,
  name: id,
  fileUri: `maps/${id}.pdf`,
  importedAt: 1,
  pageCount: pages,
  georeferences: Array.from({ length: pages }, (_, i) => geo(i)),
  activePages: Array.from({ length: pages }, (_, i) => i),
});
const fileOf = (map: MapDocument, page: number) =>
  `file://cache/${rasterFileName(map.id, page, documentRevision(map))}.png`;
const pagesRendered = () => mockRasterize.mock.calls.map(([args]) => args.pageIndex);

/** Let the worker's promise chain (origin → source → render → write) run out. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await act(async () => undefined);
}

let appStateListener: ((state: AppStateStatus) => void) | null = null;
const appState = AppState as unknown as { currentState: AppStateStatus };

beforeEach(() => {
  mockFiles.clear();
  appStateListener = null;
  appState.currentState = 'active';
  jest.mocked(AppState.addEventListener).mockImplementation((_type, handler) => {
    appStateListener = handler as (state: AppStateStatus) => void;
    return { remove: jest.fn() };
  });
  mockRasterize.mockImplementation(async (args) => result(args.source));
  useOverlayStatusStore.setState({ statuses: {} });
  useLibraryStore.setState({ hydrated: true, maps: [sheet('old')], activeMapId: null });
});

describe('usePrerenderOnImport', () => {
  it('pre-renders each active page of a picker import into the file the map reads', async () => {
    const view = await renderHook(usePrerenderOnImport);
    expect(mockRasterize).not.toHaveBeenCalled(); // 'old' was there at hydration
    const picked = sheet('picked', 2);
    await act(async () => {
      useLibraryStore.getState().addMaps([picked]);
    });
    await settle();
    expect(pagesRendered()).toEqual([0, 1]);
    expect(mockRasterize.mock.calls[0]?.[0]).toMatchObject({
      priority: 'background',
      targetWidthPx: 2048,
      source: { base64: 'picked.pdf' },
    });
    expect(mockFiles.has(fileOf(picked, 0))).toBe(true);
    expect(mockFiles.has(fileOf(picked, 1))).toBe(true);
    expect(useOverlayStatusStore.getState().statuses).toEqual({
      'picked:0': { phase: 'rendered' },
      'picked:1': { phase: 'rendered' },
    });
    await view.unmount();
  });

  it('covers a store download (addMap) and a store update (new file, same id)', async () => {
    const view = await renderHook(usePrerenderOnImport);
    const downloaded = sheet('dl');
    await act(async () => {
      useLibraryStore.getState().addMap(downloaded);
    });
    await settle();
    expect(mockFiles.has(fileOf(downloaded, 0))).toBe(true);
    await act(async () => {
      useLibraryStore.getState().updateMap('dl', { fileUri: 'maps/dl2.pdf', importedAt: 2 });
    });
    await settle();
    const updated = useLibraryStore.getState().maps.find((m) => m.id === 'dl');
    expect(updated && mockFiles.has(fileOf(updated, 0))).toBe(true);
    expect(pagesRendered()).toEqual([0, 0]);
    // A rename is not a new document.
    await act(async () => {
      useLibraryStore.getState().renameMap('dl', 'Renamed');
    });
    await settle();
    expect(mockRasterize).toHaveBeenCalledTimes(2);
    await view.unmount();
  });

  it('shows "Preparing page N…" on the card and never a rendering toast', async () => {
    let finish!: () => void;
    mockRasterize.mockImplementationOnce(
      (args) =>
        new Promise((resolve) => {
          finish = () => resolve(result(args.source));
        }),
    );
    const view = await renderHook(usePrerenderOnImport);
    const map = sheet('m');
    await act(async () => {
      useLibraryStore.getState().addMap(map);
    });
    await settle();
    const statuses = useOverlayStatusStore.getState().statuses;
    expect(statuses['m:0']).toEqual({ phase: 'preparing' });
    expect(renderStatusLine(map, statuses)).toEqual({
      kind: 'rendering',
      text: 'Preparing page 1…',
    });
    expect(renderingToasts([map], statuses, new Map())).toEqual([]);
    await act(async () => finish());
    await settle();
    expect(useOverlayStatusStore.getState().statuses['m:0']).toEqual({ phase: 'rendered' });
    await view.unmount();
  });

  it('skips pages whose raster is already on disk', async () => {
    const map = sheet('m', 2);
    mockFiles.set(fileOf(map, 0), 'png');
    const view = await renderHook(usePrerenderOnImport);
    await act(async () => {
      useLibraryStore.getState().addMap(map);
    });
    await settle();
    expect(pagesRendered()).toEqual([1]);
    await view.unmount();
  });

  it('renders one page at a time and skips the rest of a document deleted meanwhile', async () => {
    let finish!: () => void;
    mockRasterize.mockImplementationOnce(
      (args) =>
        new Promise((resolve) => {
          finish = () => resolve(result(args.source));
        }),
    );
    const view = await renderHook(usePrerenderOnImport);
    await act(async () => {
      useLibraryStore.getState().addMap(sheet('gone', 3));
    });
    await settle();
    expect(mockRasterize).toHaveBeenCalledTimes(1);
    await act(async () => {
      useLibraryStore.getState().removeMap('gone');
    });
    await act(async () => finish());
    await settle();
    expect(mockRasterize).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('never renders while the app is in the background, and resumes when it returns', async () => {
    appState.currentState = 'background';
    const view = await renderHook(usePrerenderOnImport);
    await act(async () => {
      useLibraryStore.getState().addMap(sheet('bg'));
    });
    await settle();
    expect(mockRasterize).not.toHaveBeenCalled();
    await act(async () => appStateListener?.('active'));
    await settle();
    expect(pagesRendered()).toEqual([0]);
    await view.unmount();
  });

  it('leaves a page the map is already rendering to the map', async () => {
    const map = sheet('shared');
    const pending = pendingRastersFor(mockRasterize);
    pending.set(`shared:${documentRevision(map)}:0:2048`, Promise.resolve('file://cache/x.png'));
    const view = await renderHook(usePrerenderOnImport);
    await act(async () => {
      useLibraryStore.getState().addMap(map);
    });
    await settle();
    expect(mockRasterize).not.toHaveBeenCalled();
    pending.clear();
    await view.unmount();
  });

  it('reports a failed render under pdf-prerender, clears the card, and moves on', async () => {
    mockRasterize.mockImplementationOnce(async () => {
      throw new Error('pdf load stalled in both worker modes');
    });
    const view = await renderHook(usePrerenderOnImport);
    await act(async () => {
      useLibraryStore.getState().addMap(sheet('flaky', 2));
    });
    await settle();
    expect(pagesRendered()).toEqual([0, 1]);
    expect(jest.mocked(reportError)).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'pdf load stalled in both worker modes' }),
      'pdf-prerender',
    );
    expect(useOverlayStatusStore.getState().statuses).toEqual({ 'flaky:1': { phase: 'rendered' } });
    // Silent to the user: the page stays active for the map to retry itself.
    expect(useLibraryStore.getState().maps.find((m) => m.id === 'flaky')?.activePages).toEqual([
      0, 1,
    ]);
    await view.unmount();
  });

  it('retries a render that never started, a bounded number of times, without reporting', async () => {
    mockRasterize.mockImplementation(async () => {
      throw new PdfRenderNotStartedError('engine not ready');
    });
    const view = await renderHook(usePrerenderOnImport);
    await act(async () => {
      useLibraryStore.getState().addMap(sheet('later'));
    });
    await settle();
    await settle();
    expect(mockRasterize).toHaveBeenCalledTimes(PRERENDER_MAX_ATTEMPTS);
    expect(reportError).not.toHaveBeenCalled();
    expect(useOverlayStatusStore.getState().statuses).toEqual({});
    await view.unmount();
  });
});
