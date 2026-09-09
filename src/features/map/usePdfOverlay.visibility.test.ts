// Regression tests for #233: the "PDF maps" master switch and the folder
// picker must both reach the overlay pipeline, exactly as the map screen
// wires them — `pdfOverlayMaps(...)` decides the targets, `enabled` guards
// renders in flight. Same rasterizer/storage harness as the revisions tests.
import { pdfOverlayMaps, UNGROUPED_FOLDER_ID } from '@core/library/visibility';
import type { MapVisibilityMode } from '@core/library/migrations';
import type { GeoReference, MapDocument } from '@core/models';
import { useOverlayStatusStore } from '@state/overlayStatusStore';
import { renderHook } from '@testing-library/react-native';
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
const mockServerOrigin = jest.fn(async (): Promise<string | null> => null);
jest.mock('./PdfRasterizer', () => ({
  usePdfRasterizer: () => mockRasterize,
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
  readFileBase64: async (uri: string) => uri.slice(uri.lastIndexOf('/') + 1),
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
const sheet = (id: string, folderId?: string): MapDocument => ({
  id,
  name: id,
  fileUri: `file://documents/maps/${id}.pdf`,
  importedAt: 1,
  pageCount: 1,
  activePages: [0],
  georeferences: [geo],
  folderId,
});

/** The owner's library: one sheet in a "Maps" folder, one ungrouped. */
const inMapsFolder = sheet('in-maps-folder', 'maps-folder');
const ungrouped = sheet('ungrouped-sheet');
const library = [inMapsFolder, ungrouped];

interface Props {
  showPdfMaps: boolean;
  mode: MapVisibilityMode;
  folderIds: string[];
}

/** Exactly the map screen's wiring: helper → hook, switch → `enabled`. */
const useWired = ({ showPdfMaps, mode, folderIds }: Props) =>
  usePdfOverlays(pdfOverlayMaps(showPdfMaps, mode, folderIds, library), showPdfMaps);

beforeEach(() => {
  mockFiles.clear();
  mockServerOrigin.mockReset().mockResolvedValue(null);
  useOverlayStatusStore.setState({ statuses: {} });
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('the "PDF maps" master switch', () => {
  it('off: no overlays, no rasterize call, and nothing reported on the Library cards', async () => {
    const view = await renderHook(useWired, {
      initialProps: { showPdfMaps: false, mode: 'type', folderIds: [] },
    });
    expect(view.result.current).toEqual({ overlays: [], loading: false, error: null });
    expect(mockRasterize).not.toHaveBeenCalled();
    expect(mockServerOrigin).not.toHaveBeenCalled();
    expect(useOverlayStatusStore.getState().statuses).toEqual({});
  });

  it('flipping it off drops every drawn sheet at once and quiets its card status', async () => {
    const view = await renderHook(useWired, {
      initialProps: { showPdfMaps: true, mode: 'type', folderIds: [] },
    });
    expect(view.result.current.overlays.map((o) => o.id)).toEqual([
      'in-maps-folder:0',
      'ungrouped-sheet:0',
    ]);
    expect(mockRasterize).toHaveBeenCalledTimes(2);
    expect(Object.keys(useOverlayStatusStore.getState().statuses)).toHaveLength(2);

    await view.rerender({ showPdfMaps: false, mode: 'type', folderIds: [] });
    expect(view.result.current).toEqual({ overlays: [], loading: false, error: null });
    expect(useOverlayStatusStore.getState().statuses).toEqual({});

    // Back on: the cached rasters come straight back, nothing re-renders.
    await view.rerender({ showPdfMaps: true, mode: 'type', folderIds: [] });
    expect(view.result.current.overlays).toHaveLength(2);
    expect(mockRasterize).toHaveBeenCalledTimes(2);
  });

  it('wins over the folder picker — off targets nothing in folder mode too', async () => {
    const view = await renderHook(useWired, {
      initialProps: {
        showPdfMaps: false,
        mode: 'folders',
        folderIds: ['maps-folder', UNGROUPED_FOLDER_ID],
      },
    });
    expect(view.result.current.overlays).toEqual([]);
    expect(mockRasterize).not.toHaveBeenCalled();
  });
});

describe('folder selection', () => {
  it('"Ungrouped" excludes a sheet that lives in a folder, and never rasterizes it', async () => {
    const view = await renderHook(useWired, {
      initialProps: { showPdfMaps: true, mode: 'folders', folderIds: [UNGROUPED_FOLDER_ID] },
    });
    expect(view.result.current.overlays.map((o) => o.id)).toEqual(['ungrouped-sheet:0']);
    expect(mockRasterize).toHaveBeenCalledTimes(1);
    expect(Object.keys(useOverlayStatusStore.getState().statuses)).toEqual(['ungrouped-sheet:0']);
  });

  it('switching folders swaps the drawn sheet immediately', async () => {
    const view = await renderHook(useWired, {
      initialProps: { showPdfMaps: true, mode: 'folders', folderIds: ['maps-folder'] },
    });
    expect(view.result.current.overlays.map((o) => o.id)).toEqual(['in-maps-folder:0']);

    await view.rerender({ showPdfMaps: true, mode: 'folders', folderIds: [UNGROUPED_FOLDER_ID] });
    expect(view.result.current.overlays.map((o) => o.id)).toEqual(['ungrouped-sheet:0']);

    // "Everything" draws both again; the first sheet's raster is reused.
    await view.rerender({ showPdfMaps: true, mode: 'type', folderIds: [UNGROUPED_FOLDER_ID] });
    expect(view.result.current.overlays.map((o) => o.id)).toEqual([
      'in-maps-folder:0',
      'ungrouped-sheet:0',
    ]);
    expect(mockRasterize).toHaveBeenCalledTimes(2);
  });
});
