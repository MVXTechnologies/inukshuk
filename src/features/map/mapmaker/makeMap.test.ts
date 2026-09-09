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
jest.mock('@state/libraryStore', () => {
  const addMap = jest.fn();
  return { useLibraryStore: { getState: () => ({ tracks: [], waypoints: [], addMap }) } };
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const bbox = { minLng: -71.3, minLat: 46.7, maxLng: -71.1, maxLat: 46.9 };
const options = { name: 'Sheet', includeUserData: false, compass: false } as MakeMapOptions;
const doc = { id: 'made', name: 'Sheet', georeferences: [{}] } as unknown as MapDocument;
const addMap = () => jest.mocked(useLibraryStore.getState().addMap);

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
