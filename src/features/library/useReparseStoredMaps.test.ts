/**
 * The once-per-launch catch-up that re-parses stored maps whose georeferencing
 * predates the current parser (#336).
 */
import { GEOPDF_PARSER_REVISION } from '@core/geo/geopdf';
import type { GeoReference, MapDocument } from '@core/models';
import { act, renderHook } from '@testing-library/react-native';

import { reparseStoredMaps, useReparseStoredMaps } from './useReparseStoredMaps';

const mockParseGeoPdf = jest.fn();
const mockWithFileByteSource = jest.fn();
const mockReportError = jest.fn();
const mockUpdateMap = jest.fn();

jest.mock('@core/geo/geopdf', () => ({
  ...jest.requireActual('@core/geo/geopdf'),
  parseGeoPdf: (...args: unknown[]) => mockParseGeoPdf(...args),
}));
jest.mock('@data/storage', () => ({
  withFileByteSource: (...args: unknown[]) => mockWithFileByteSource(...args),
}));
jest.mock('@lib/errorReporting', () => ({
  reportError: (...a: unknown[]) => mockReportError(...a),
}));

let mockState: { hydrated: boolean; maps: MapDocument[] };
jest.mock('@state/libraryStore', () => ({
  useLibraryStore: Object.assign((selector: (s: unknown) => unknown) => selector(mockState), {
    getState: () => ({ ...mockState, updateMap: mockUpdateMap }),
  }),
}));

const geo = (pageIndex: number, revision?: number, north = 46.9): GeoReference =>
  ({
    pageIndex,
    source: 'adobe-geo',
    pageWidthPt: 612,
    pageHeightPt: 792,
    ...(revision === undefined ? {} : { parserRevision: revision }),
    viewport: {
      rect: { x0: 0, y0: 0, x1: 612, y1: 792 },
      corners: {
        topLeft: [-71, north],
        topRight: [-70, north],
        bottomRight: [-70, 46],
        bottomLeft: [-71, 46],
      },
    },
    bbox: { minLng: -71, minLat: 46, maxLng: -70, maxLat: north },
  }) as GeoReference;

const map = (over: Partial<MapDocument> = {}): MapDocument => ({
  id: 'm1',
  name: 'Sheet',
  fileUri: 'maps/m1.pdf',
  importedAt: 1,
  pageCount: 1,
  georeferences: [geo(0)],
  activePages: [0],
  ...over,
});

/**
 * Drains the queue directly.
 *
 * Deliberately NOT through the hook: the worker keeps yielding after the
 * assertions, and a loop resolving outside React's act scope stops the NEXT
 * test's effects from flushing (three silent false passes before that was
 * pinned down). The hook itself is covered by its own case below.
 */
const runWorker = (): Promise<void> => reparseStoredMaps();

beforeEach(() => {
  mockState = { hydrated: true, maps: [] };
  mockWithFileByteSource.mockImplementation((_uri: string, fn: (s: unknown) => unknown) => fn({}));
  mockParseGeoPdf.mockReturnValue({ pageCount: 1, georeferences: [geo(0)], warnings: [] });
});

it('re-parses a map stored by an older parser and writes the fresh corners back', async () => {
  mockState.maps = [map()];
  // The real regression: the stored copy has the top edge SOUTH of the
  // bottom edge, which is how an EcoLL1-class sheet drew upside down.
  mockState.maps[0]!.georeferences = [geo(0, 1, 45.5)];
  mockParseGeoPdf.mockReturnValue({
    pageCount: 1,
    georeferences: [geo(0, undefined, 46.9)],
    warnings: [],
  });

  await runWorker();

  expect(mockUpdateMap).toHaveBeenCalledTimes(1);
  const [id, patch] = mockUpdateMap.mock.calls[0] as [string, { georeferences: GeoReference[] }];
  expect(id).toBe('m1');
  const corners = patch.georeferences[0]!.viewport!.corners;
  expect(corners.topLeft[1]).toBeGreaterThan(corners.bottomLeft[1]);
  expect(patch.georeferences[0]!.parserRevision).toBe(GEOPDF_PARSER_REVISION);
});

it('leaves a map already produced by the current parser untouched', async () => {
  mockState.maps = [map({ georeferences: [geo(0, GEOPDF_PARSER_REVISION)] })];
  await runWorker();
  expect(mockWithFileByteSource).not.toHaveBeenCalled();
  expect(mockUpdateMap).not.toHaveBeenCalled();
});

it('the hook waits for the library to hydrate, then runs once', async () => {
  // renderHook is async in this RNTL version, and so is unmount().
  mockState = { hydrated: false, maps: [map()] };
  const idle = await renderHook(() => useReparseStoredMaps());
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(mockWithFileByteSource).not.toHaveBeenCalled();
  await idle.unmount();

  mockState = { hydrated: true, maps: [map()] };
  const live = await renderHook(() => useReparseStoredMaps());
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(mockWithFileByteSource).toHaveBeenCalledTimes(1);
  await live.unmount();
});

it('works through several stale maps, one read at a time', async () => {
  mockState.maps = [map({ id: 'a' }), map({ id: 'b' }), map({ id: 'c' })];
  await runWorker();
  expect(mockWithFileByteSource).toHaveBeenCalledTimes(3);
  expect(mockUpdateMap.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c']);
});

it('keeps the stored georeferencing when a re-parse comes back empty', async () => {
  mockState.maps = [map()];
  mockParseGeoPdf.mockReturnValue({ pageCount: 1, georeferences: [], warnings: ['truncated'] });
  await runWorker();
  expect(mockUpdateMap).not.toHaveBeenCalled();
  expect(mockReportError).toHaveBeenCalledWith(expect.any(Error), 'pdf-reparse');
});

it('reports a failed read and carries on with the next map', async () => {
  mockState.maps = [map({ id: 'bad' }), map({ id: 'good' })];
  mockWithFileByteSource.mockImplementationOnce(() => {
    throw new Error('file handle is closed');
  });
  await runWorker();
  expect(mockReportError).toHaveBeenCalledWith(expect.any(Error), 'pdf-reparse');
  expect(mockUpdateMap.mock.calls.map((c) => c[0])).toEqual(['good']);
});

it('skips a map deleted while the queue was draining', async () => {
  mockState.maps = [map({ id: 'a' }), map({ id: 'b' })];
  mockWithFileByteSource.mockImplementationOnce((_uri: string, fn: (s: unknown) => unknown) => {
    mockState.maps = mockState.maps.filter((m) => m.id !== 'b');
    return fn({});
  });
  await runWorker();
  expect(mockUpdateMap.mock.calls.map((c) => c[0])).toEqual(['a']);
});
