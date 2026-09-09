import type { CatalogItem } from '@core/catalog/schema';
import type { MapDocument } from '@core/models';
import { downloadCatalogPdf } from '@data/catalogDownload';
import * as storage from '@data/storage';
import { useCatalogStore } from '@state/catalogStore';
import { useLibraryStore } from '@state/libraryStore';
import { mapDocumentFromStoredPdf } from '../library/importMap';
import {
  CatalogDownloadCanceled,
  cancelCatalogDownload,
  downloadCatalogItemToLibrary,
} from './downloadCatalogItem';

jest.mock('@data/storage', () => ({
  ...jest
    .requireActual<typeof import('@data/storageTestMock')>('@data/storageTestMock')
    .documentPathMocks(),
  ensureStorage: jest.fn(),
  readIndex: jest.fn(async () => null),
  writeIndex: jest.fn(),
  newId: jest.fn(() => 'new-file-id'),
  deleteFileAt: jest.fn(),
}));

jest.mock('@data/catalogDownload', () => ({
  __esModule: true,
  CatalogDownloadCanceled: class CatalogDownloadCanceled extends Error {},
  downloadCatalogPdf: jest.fn(),
}));

jest.mock('@data/catalogCache', () => ({
  loadCatalogManifest: jest.fn(async () => null),
}));

jest.mock('../library/importMap', () => ({
  mapDocumentFromStoredPdf: jest.fn(),
}));

jest.mock('@lib/errorReporting', () => ({
  reportError: jest.fn(),
}));

const downloadMock = downloadCatalogPdf as jest.Mock;
const parseMock = mapDocumentFromStoredPdf as jest.Mock;
const newIdMock = storage.newId as jest.Mock;

const item: CatalogItem = {
  id: 'cantopo-021l14',
  sourceId: 'nrcan-cantopo',
  title: 'Québec — CanTopo 021L14',
  category: 'topo',
  format: 'geopdf',
  packaging: 'zip',
  sizeBytes: 5_000_000,
  url: 'https://example.com/cantopo_021l14_geopdf.zip',
  updatedAt: '2019-07-24',
};

const parsedDoc = (id: string): MapDocument => ({
  id,
  name: 'Québec — CanTopo 021L14',
  fileUri: `file://maps/${id}.pdf`,
  importedAt: 42,
  pageCount: 1,
  georeferences: [
    {
      pageIndex: 0,
      source: 'adobe-geo',
      pageWidthPt: 612,
      pageHeightPt: 792,
      viewport: {
        rect: { x0: 0, y0: 0, x1: 612, y1: 792 },
        corners: {
          topLeft: [-71.5, 47],
          topRight: [-71, 47],
          bottomRight: [-71, 46.75],
          bottomLeft: [-71.5, 46.75],
        },
      },
      bbox: { minLat: 46.75, maxLat: 47, minLng: -71.5, maxLng: -71 },
    },
  ],
  activePages: [0],
});

beforeEach(() => {
  jest.mocked(storage.writeIndex).mockReset();
  jest.mocked(storage.deleteFileAt).mockReset();
  useLibraryStore.setState({
    maps: [],
    folders: [{ id: 'folder-9', name: 'Parcs', createdAt: 1 }],
    activeMapId: null,
    hydrated: true,
  });
  useCatalogStore.setState({ downloads: {}, lastFolderId: null });
  newIdMock.mockReturnValue('new-file-id');
});

describe('downloadCatalogItemToLibrary', () => {
  it('lands a fresh download as a regular Library map with provenance + folder', async () => {
    downloadMock.mockImplementation((_item, mapId: string, onProgress) => {
      onProgress(0.5);
      return { promise: Promise.resolve(`file://maps/${mapId}.pdf`), cancel: jest.fn() };
    });
    parseMock.mockResolvedValue(parsedDoc('new-file-id'));

    const doc = await downloadCatalogItemToLibrary(item, 'folder-9');

    expect(parseMock).toHaveBeenCalledWith(
      'new-file-id',
      'file://maps/new-file-id.pdf',
      'Québec — CanTopo 021L14',
    );
    const lib = useLibraryStore.getState();
    expect(lib.maps).toHaveLength(1);
    expect(lib.maps[0]).toMatchObject({
      id: 'new-file-id',
      folderId: 'folder-9',
      sourceItemId: 'cantopo-021l14',
      sourceUpdatedAt: '2019-07-24',
    });
    expect(lib.activeMapId).toBe('new-file-id'); // addMap activates, like any import
    expect(doc.sourceItemId).toBe('cantopo-021l14');
    // Progress cleared once the download settles; folder remembered.
    expect(useCatalogStore.getState().downloads).toEqual({});
    expect(useCatalogStore.getState().lastFolderId).toBe('folder-9');
  });

  it('publishes progress into the catalog store while downloading', async () => {
    let capturedProgress: ((f: number | null) => void) | undefined;
    let resolveDownload!: (uri: string) => void;
    downloadMock.mockImplementation((_i, _id, onProgress) => {
      capturedProgress = onProgress;
      return {
        promise: new Promise<string>((resolve) => {
          resolveDownload = resolve;
        }),
        cancel: jest.fn(),
      };
    });
    parseMock.mockResolvedValue(parsedDoc('new-file-id'));

    const pending = downloadCatalogItemToLibrary(item, null);
    expect(useCatalogStore.getState().downloads['cantopo-021l14']).toBe(0);
    capturedProgress?.(0.75);
    expect(useCatalogStore.getState().downloads['cantopo-021l14']).toBe(0.75);
    resolveDownload('file://maps/new-file-id.pdf');
    await pending;
    expect(useCatalogStore.getState().downloads).toEqual({});
  });

  it('updates an installed map in place: same id, name and folder, new file', async () => {
    useLibraryStore.setState({
      maps: [
        {
          ...parsedDoc('old-id'),
          name: 'My renamed sheet',
          fileUri: 'file://maps/old-id.pdf',
          folderId: 'folder-9',
          sourceItemId: 'cantopo-021l14',
          sourceUpdatedAt: '2018-01-01',
        },
      ],
    });
    newIdMock.mockReturnValue('replacement-file');
    downloadMock.mockReturnValue({
      promise: Promise.resolve('file://maps/replacement-file.pdf'),
      cancel: jest.fn(),
    });
    parseMock.mockResolvedValue(parsedDoc('replacement-file'));

    const doc = await downloadCatalogItemToLibrary(item, null);

    // The update parsed under the existing (possibly renamed) display name.
    expect(parseMock).toHaveBeenCalledWith(
      'replacement-file',
      'file://maps/replacement-file.pdf',
      'My renamed sheet',
    );
    const lib = useLibraryStore.getState();
    expect(lib.maps).toHaveLength(1); // never a duplicate row
    expect(lib.maps[0]).toMatchObject({
      id: 'old-id',
      name: 'My renamed sheet',
      folderId: 'folder-9',
      fileUri: 'file://maps/replacement-file.pdf',
      sourceUpdatedAt: '2019-07-24',
    });
    expect(storage.deleteFileAt).toHaveBeenCalledWith('file://maps/old-id.pdf');
    expect(doc.id).toBe('old-id');
  });

  it('propagates cancellation and clears progress without touching the Library', async () => {
    const cancel = jest.fn();
    downloadMock.mockImplementation(() => ({
      promise: new Promise<string>((_resolve, reject) => {
        cancel.mockImplementation(() => reject(new CatalogDownloadCanceled()));
      }),
      cancel,
    }));

    const pending = downloadCatalogItemToLibrary(item, null);
    cancelCatalogDownload('cantopo-021l14');
    await expect(pending).rejects.toBeInstanceOf(CatalogDownloadCanceled);
    expect(cancel).toHaveBeenCalled();
    expect(useLibraryStore.getState().maps).toHaveLength(0);
    expect(useCatalogStore.getState().downloads).toEqual({});
  });

  it('surfaces a parse failure (and still clears the progress row)', async () => {
    downloadMock.mockReturnValue({
      promise: Promise.resolve('file://maps/new-file-id.pdf'),
      cancel: jest.fn(),
    });
    parseMock.mockRejectedValue(new Error('not a pdf'));

    await expect(downloadCatalogItemToLibrary(item, null)).rejects.toThrow('not a pdf');
    expect(useLibraryStore.getState().maps).toHaveLength(0);
    expect(useCatalogStore.getState().downloads).toEqual({});
  });

  it('rejects a second download of an item already in flight', async () => {
    let rejectDownload!: (error: Error) => void;
    downloadMock.mockReturnValue({
      promise: new Promise<string>((_resolve, reject) => {
        rejectDownload = reject;
      }),
      cancel: () => rejectDownload(new CatalogDownloadCanceled()),
    });
    const first = downloadCatalogItemToLibrary(item, null);
    await expect(downloadCatalogItemToLibrary(item, null)).rejects.toThrow('already downloading');
    cancelCatalogDownload('cantopo-021l14');
    await expect(first).rejects.toBeInstanceOf(CatalogDownloadCanceled);
  });
});

describe('catalog replacement durability (audit A01)', () => {
  const old = { ...parsedDoc('old-id'), sourceItemId: item.id };
  const replacement = parsedDoc('replacement-file');

  beforeEach(() => {
    useLibraryStore.setState({ maps: [old] });
    downloadMock.mockReturnValue({
      promise: Promise.resolve(replacement.fileUri),
      cancel: jest.fn(),
    });
    parseMock.mockResolvedValue(replacement);
  });

  it('keeps the durable map and its bytes when the replacement index write fails', async () => {
    const files = new Set([old.fileUri, replacement.fileUri]);
    let durableMaps = [old];
    jest.mocked(storage.deleteFileAt).mockImplementation((uri) => {
      files.delete(uri);
    });
    jest.mocked(storage.writeIndex).mockImplementationOnce(() => {
      throw new Error('ENOSPC');
    });

    await expect(downloadCatalogItemToLibrary(item, null)).rejects.toThrow('ENOSPC');

    expect(useLibraryStore.getState().maps).toEqual(durableMaps);
    expect(files.has(old.fileUri)).toBe(true);
    expect(files.has(replacement.fileUri)).toBe(true);
    // A cold launch uses this last successful index, whose file is still present.
    expect(files.has(durableMaps[0]!.fileUri)).toBe(true);

    jest.mocked(storage.writeIndex).mockImplementation((index) => {
      durableMaps = (index as { maps: typeof durableMaps }).maps;
    });
    files.add(replacement.fileUri);
    await downloadCatalogItemToLibrary(item, null);
    expect(durableMaps[0]?.fileUri).toBe(replacement.fileUri);
    expect(files.has(old.fileUri)).toBe(false);
  });

  it('commits replacement metadata before deleting old bytes, tolerating cleanup failure', async () => {
    const operations: string[] = [];
    jest.mocked(storage.writeIndex).mockImplementation(() => {
      operations.push('commit');
    });
    jest.mocked(storage.deleteFileAt).mockImplementation(() => {
      operations.push('delete');
      throw new Error('cannot delete');
    });
    await expect(downloadCatalogItemToLibrary(item, null)).resolves.toMatchObject({
      id: old.id,
      fileUri: replacement.fileUri,
    });
    expect(operations).toEqual(['commit', 'delete']);
    expect(storage.deleteFileAt).toHaveBeenCalledWith(old.fileUri);
    expect(useLibraryStore.getState().maps[0]?.fileUri).toBe(replacement.fileUri);
  });

  it('retains a fresh download when the failed commit may have staged its metadata', async () => {
    useLibraryStore.setState({ maps: [] });
    jest.mocked(storage.writeIndex).mockImplementationOnce(() => {
      throw new Error('ENOSPC');
    });
    await expect(downloadCatalogItemToLibrary(item, null)).rejects.toThrow('ENOSPC');
    expect(useLibraryStore.getState().maps).toEqual([]);
    expect(storage.deleteFileAt).not.toHaveBeenCalled();
  });

  it('retains replacement bytes when a failed promotion leaves a recoverable replacement index', async () => {
    let recoverableMaps: MapDocument[] = [old];
    jest.mocked(storage.writeIndex).mockImplementationOnce((index) => {
      // writeJson can fail after deleting the old index; readJson then recovers
      // this completed .tmp payload on the next launch.
      recoverableMaps = (index as { maps: MapDocument[] }).maps;
      throw new Error('promotion failed');
    });
    await expect(downloadCatalogItemToLibrary(item, null)).rejects.toThrow('promotion failed');
    expect(recoverableMaps[0]?.fileUri).toBe(replacement.fileUri);
    expect(useLibraryStore.getState().maps).toEqual([old]);
    expect(storage.deleteFileAt).not.toHaveBeenCalled();
  });

  it('retains the installed map when hydration cannot guarantee a durable commit', async () => {
    useLibraryStore.setState({ hydrated: false });
    await expect(downloadCatalogItemToLibrary(item, null)).rejects.toThrow('still loading');
    expect(useLibraryStore.getState().maps).toEqual([old]);
    expect(storage.deleteFileAt).toHaveBeenCalledTimes(1);
    expect(storage.deleteFileAt).toHaveBeenCalledWith(replacement.fileUri);
  });

  it.each(['deleted', 'replaced'])(
    'abandons an update whose installation was %s during parsing',
    async (change) => {
      let finish!: (doc: MapDocument) => void;
      parseMock.mockImplementation(
        () =>
          new Promise<MapDocument>((resolve) => {
            finish = resolve;
          }),
      );
      const pending = downloadCatalogItemToLibrary(item, null);
      await Promise.resolve();
      const maps = change === 'deleted' ? [] : [{ ...old, fileUri: 'file://maps/newer.pdf' }];
      useLibraryStore.setState({ maps });
      finish(replacement);

      await expect(pending).rejects.toBeInstanceOf(CatalogDownloadCanceled);
      expect(useLibraryStore.getState().maps).toEqual(maps);
      expect(storage.writeIndex).not.toHaveBeenCalled();
      expect(storage.deleteFileAt).toHaveBeenCalledTimes(1);
      expect(storage.deleteFileAt).toHaveBeenCalledWith(replacement.fileUri);
    },
  );
});
