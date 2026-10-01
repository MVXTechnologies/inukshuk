/**
 * "See-through white" in the overlay pipeline: the level is part of the
 * raster's identity (file name + cache key), so switching renders each page
 * once per level and is instant afterwards; a map's own override wins over
 * the global level; and while a new level renders, the page keeps showing
 * its raster at the old level instead of disappearing.
 */
import type { GeoReference, MapDocument } from '@core/models';
import type { WhiteKeyLevel } from '@core/geo/pdfWhiteKey';
import { act, renderHook } from '@testing-library/react-native';
import type { RasterizeArgs, RasterResult } from './PdfRasterizer';
import { usePdfOverlays } from './usePdfOverlay';

const mockFiles = new Map<string, string>();
const raster = (tag: string): RasterResult => ({
  pngDataUri: `data:image/png;base64,${tag}`,
  widthPx: 2048,
  heightPx: 2048,
  pageWidthPt: 100,
  pageHeightPt: 100,
  pageCount: 1,
  loadMs: 1,
  renderMs: 1,
});
const mockRasterize = jest.fn(async (args: RasterizeArgs) => raster(args.whiteKey ?? 'off'));
jest.mock('./PdfRasterizer', () => ({
  usePdfRasterizer: () => mockRasterize,
  usePdfRasterizerServer: () => async () => null,
}));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));
jest.mock('expo-file-system', () => ({ File: class {} }));
jest.mock('@data/storage', () => ({
  resolveDocumentPath: (uri: string) => uri,
  toDocumentPath: (uri: string) => uri.replace('file://documents/', ''),
  fileSizeAt: () => 10,
  readFileBase64: async () => 'PDF',
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
  id: 'wk',
  name: 'Sheet',
  fileUri: 'file://documents/maps/sheet.pdf',
  importedAt: 1,
  pageCount: 1,
  activePages: [0],
  georeferences: [geo],
};

type Props = { maps: MapDocument[]; level: WhiteKeyLevel };
const mount = (props: Props) =>
  renderHook(({ maps, level }: Props) => usePdfOverlays(maps, true, level), {
    initialProps: props,
  });

beforeEach(() => {
  mockFiles.clear();
  mockRasterize.mockClear();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

it('renders at the global level, under a name that carries it', async () => {
  const view = await mount({ maps: [map], level: 'full' });
  expect(mockRasterize).toHaveBeenCalledTimes(1);
  expect(mockRasterize.mock.calls[0]?.[0]).toMatchObject({ whiteKey: 'full' });
  const overlay = view.result.current.overlays[0];
  expect(overlay?.whiteKey).toBe('full');
  expect(overlay?.imageUri).toMatch(/_wk-full\.png$/);
  expect(mockFiles.get(overlay?.imageUri ?? '')).toBe('full');
});

it('keeps the pre-feature name at Off, so existing caches stay valid', async () => {
  const view = await mount({ maps: [map], level: 'off' });
  expect(view.result.current.overlays[0]?.imageUri).toMatch(/_2048\.png$/);
  expect(mockRasterize.mock.calls[0]?.[0]).toMatchObject({ whiteKey: 'off' });
});

it("lets a map's own level override the global one", async () => {
  const view = await mount({ maps: [{ ...map, whiteKey: 'some' }], level: 'full' });
  expect(mockRasterize.mock.calls[0]?.[0]).toMatchObject({ whiteKey: 'some' });
  expect(view.result.current.overlays[0]?.whiteKey).toBe('some');
});

it('renders once per level, then switches instantly both ways', async () => {
  const view = await mount({ maps: [map], level: 'off' });
  await act(async () => view.rerender({ maps: [map], level: 'full' }));
  expect(mockRasterize).toHaveBeenCalledTimes(2);
  const full = view.result.current.overlays[0]?.imageUri;

  await act(async () => view.rerender({ maps: [map], level: 'off' }));
  await act(async () => view.rerender({ maps: [map], level: 'full' }));
  expect(mockRasterize).toHaveBeenCalledTimes(2);
  expect(view.result.current.overlays[0]?.imageUri).toBe(full);
  expect(view.result.current.overlays).toHaveLength(1);
});

it('shows the old level while the new one renders, then swaps it in place', async () => {
  const view = await mount({ maps: [map], level: 'off' });
  const plain = view.result.current.overlays[0]?.imageUri;
  let finish!: (value: RasterResult) => void;
  mockRasterize.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => view.rerender({ maps: [map], level: 'some' }));
  // Still drawn — at the old level, never blank and never a stale keyed tile.
  expect(view.result.current.overlays).toHaveLength(1);
  expect(view.result.current.overlays[0]).toMatchObject({ imageUri: plain, whiteKey: 'off' });
  expect(view.result.current.loading).toBe(true);

  await act(async () => finish(raster('some')));
  expect(view.result.current.overlays).toHaveLength(1);
  expect(view.result.current.overlays[0]?.whiteKey).toBe('some');
  expect(view.result.current.overlays[0]?.imageUri).toMatch(/_wk-some\.png$/);
  expect(view.result.current.loading).toBe(false);
});

it('drops the stand-in when the new level fails to render', async () => {
  const view = await mount({ maps: [map], level: 'off' });
  mockRasterize.mockRejectedValueOnce(new Error('boom'));
  await act(async () => view.rerender({ maps: [map], level: 'full' }));
  expect(view.result.current.overlays).toHaveLength(0);
  expect(view.result.current.error).toBe('boom');
});
