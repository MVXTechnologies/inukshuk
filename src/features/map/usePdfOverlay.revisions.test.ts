import type { GeoReference, MapDocument } from '@core/models';
import { act, renderHook } from '@testing-library/react-native';
import { usePdfOverlays } from './usePdfOverlay';

const mockFiles = new Map<string, string>();
const mockRasterize = jest.fn(async ({ source }: { source: { base64: string } }) => ({
  pngDataUri: `data:image/png;base64,${source.base64}`,
  widthPx: 2048,
  heightPx: 2048,
  pageWidthPt: 100,
  pageHeightPt: 100,
  pageCount: 1,
  loadMs: 1,
  renderMs: 1,
}));
const mockServerOrigin = async () => null;
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
  toDocumentPath: (uri: string) => uri.replace('file://documents/', ''),
  fileSizeAt: () => 10,
  readFileBase64: async (uri: string) => (uri.endsWith('new.pdf') ? 'NEW' : 'OLD'),
  existingOverlayPng: (id: string) =>
    mockFiles.has(`file://cache/${id}.png`) ? `file://cache/${id}.png` : null,
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
