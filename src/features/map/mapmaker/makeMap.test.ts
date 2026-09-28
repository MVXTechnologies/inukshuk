import type { MapDocument } from '@core/models';
import * as storage from '@data/storage';
import { useLibraryStore } from '@state/libraryStore';
import { mapDocumentFromStoredPdf } from '../../library/importMap';
import { composeMapPdf, type ComposeHandle, type MakeMapOptions } from './composeMapPdf';
import { makeMap } from './makeMap';

jest.mock('./composeMapPdf', () => ({ composeMapPdf: jest.fn() }));
jest.mock('../../library/importMap', () => ({ mapDocumentFromStoredPdf: jest.fn() }));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));
jest.mock('expo-location', () => ({ getHeadingAsync: jest.fn() }));
jest.mock('@data/storage', () => ({
  newId: () => 'made',
  readFileText: jest.fn(),
  writeMapPdfBytes: jest.fn(() => 'file:///doc/maps/made.pdf'),
  deleteFileAt: jest.fn(),
}));
const mockLibState: { tracks: unknown[]; waypoints: unknown[]; addMap: jest.Mock } = {
  tracks: [],
  waypoints: [],
  addMap: jest.fn(),
};
jest.mock('@state/libraryStore', () => ({
  useLibraryStore: { getState: () => mockLibState },
}));

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const bbox = { minLng: -71.3, minLat: 46.7, maxLng: -71.1, maxLat: 46.9 };
// `format` is required and the layout needs it — the old cast hid that.
const options = {
  name: 'Sheet',
  format: 'a4',
  includeUserData: false,
  compass: false,
} as MakeMapOptions;
const doc = { id: 'made', name: 'Sheet', georeferences: [{}] } as unknown as MapDocument;
const addMap = () => jest.mocked(useLibraryStore.getState().addMap);

const track = (id: string, bbox?: Record<string, number>) => ({
  id,
  name: id,
  startedAt: 0,
  fileUri: `file:///gpx/${id}.gpx`,
  stats: { bbox, distanceM: 0, pointCount: 2 },
});

describe('makeMap cancellation (#309)', () => {
  it('a Cancel that lands while the composer is running saves nothing', async () => {
    const compose = deferred<Uint8Array>();
    jest.mocked(composeMapPdf).mockReturnValue(compose.promise);
    const handle: ComposeHandle = { aborted: false };
    const run = makeMap(bbox, options, jest.fn(), handle);
    handle.aborted = true;
    compose.resolve(new Uint8Array([1]));

    await expect(run).rejects.toThrow('aborted');
    expect(storage.writeMapPdfBytes).not.toHaveBeenCalled();
    expect(mapDocumentFromStoredPdf).not.toHaveBeenCalled();
    expect(addMap()).not.toHaveBeenCalled();
  });

  it('a Cancel during the re-parse deletes the written PDF instead of adding it', async () => {
    jest.mocked(composeMapPdf).mockResolvedValue(new Uint8Array([1]));
    const parse = deferred<MapDocument>();
    jest.mocked(mapDocumentFromStoredPdf).mockReturnValue(parse.promise);
    const handle: ComposeHandle = { aborted: false };
    const run = makeMap(bbox, options, jest.fn(), handle);
    // Let the compose settle and the write happen, then cancel mid-parse.
    await new Promise((r) => setTimeout(r, 0));
    expect(storage.writeMapPdfBytes).toHaveBeenCalledTimes(1);
    handle.aborted = true;
    parse.resolve(doc);

    await expect(run).rejects.toThrow('aborted');
    expect(storage.deleteFileAt).toHaveBeenCalledWith('file:///doc/maps/made.pdf');
    expect(addMap()).not.toHaveBeenCalled();
  });

  it('an un-cancelled run lands in the library', async () => {
    jest.mocked(composeMapPdf).mockResolvedValue(new Uint8Array([1]));
    jest.mocked(mapDocumentFromStoredPdf).mockResolvedValue(doc);
    await expect(makeMap(bbox, options, jest.fn(), { aborted: false })).resolves.toBe(doc);
    expect(addMap()).toHaveBeenCalledWith(doc);
    expect(storage.deleteFileAt).not.toHaveBeenCalled();
  });
});

describe('makeMap content selection (#356)', () => {
  const near = { minLng: -71.25, minLat: 46.8, maxLng: -71.2, maxLat: 46.85 };
  const far = { minLng: -60, minLat: 20, maxLng: -59, maxLat: 21 };

  beforeEach(() => {
    mockLibState.tracks = [track('near', near), track('far', far), track('alsoNear', near)];
    mockLibState.waypoints = [
      { id: 'in', longitude: -71.22, latitude: 46.82, label: 'Waypoint 1' },
      { id: 'out', longitude: 0, latitude: 0, label: 'Waypoint 2' },
    ];
    jest.mocked(composeMapPdf).mockResolvedValue(new Uint8Array([1]));
    jest.mocked(mapDocumentFromStoredPdf).mockResolvedValue(doc);
    jest
      .mocked(storage.readFileText)
      .mockResolvedValue(
        '<gpx><trk><trkseg><trkpt lat="46.82" lon="-71.22"/></trkseg></trk></gpx>',
      );
  });

  const composedInput = () => jest.mocked(composeMapPdf).mock.calls[0]![0];

  it('never reads a GPX that cannot reach the page', async () => {
    await makeMap(bbox, { ...options, includeUserData: true }, jest.fn(), { aborted: false });
    const read = jest.mocked(storage.readFileText).mock.calls.map((c) => c[0]);
    expect(read).toEqual(['file:///gpx/near.gpx', 'file:///gpx/alsoNear.gpx']);
    expect(read).not.toContain('file:///gpx/far.gpx');
  });

  it('reads only the tracks the picker chose', async () => {
    await makeMap(bbox, { ...options, includeUserData: true, trackIds: ['alsoNear'] }, jest.fn(), {
      aborted: false,
    });
    expect(jest.mocked(storage.readFileText).mock.calls.map((c) => c[0])).toEqual([
      'file:///gpx/alsoNear.gpx',
    ]);
  });

  it('reads nothing when the picker is empty', async () => {
    await makeMap(bbox, { ...options, includeUserData: true, trackIds: [] }, jest.fn(), {
      aborted: false,
    });
    expect(storage.readFileText).not.toHaveBeenCalled();
    expect(composedInput().tracks).toEqual([]);
  });

  it('draws only the waypoints on the page, keeping their map numbers', async () => {
    await makeMap(bbox, { ...options, includeUserData: true }, jest.fn(), { aborted: false });
    expect(composedInput().waypoints).toEqual([{ index: 1, pos: [-71.22, 46.82] }]);
  });

  it('touches no file at all when user data is off', async () => {
    await makeMap(bbox, { ...options, includeUserData: false }, jest.fn(), { aborted: false });
    expect(storage.readFileText).not.toHaveBeenCalled();
    expect(composedInput().waypoints).toEqual([]);
  });
});
