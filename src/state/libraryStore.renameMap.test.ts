import type { GeoReference, MapDocument } from '@core/models';

import { useLibraryStore } from './libraryStore';

jest.mock('@data/storage', () => ({
  newId: () => 'r_' + Math.random().toString(36).slice(2, 8),
  deleteFileAt: jest.fn(),
  writeJson: jest.fn(),
  writeIndex: jest.fn(),
}));

const storage = jest.requireMock('@data/storage') as { writeIndex: jest.Mock };

const doc = (id: string, name: string): MapDocument => ({
  id,
  name,
  fileUri: `file://${id}.pdf`,
  pageCount: 1,
  georeferences: [],
  activePages: [],
  importedAt: 1,
});

const georeference: GeoReference = {
  pageIndex: 0,
  source: 'adobe-geo',
  pageWidthPt: 612,
  pageHeightPt: 792,
  viewport: {
    rect: { x0: 0, y0: 0, x1: 612, y1: 792 },
    corners: {
      topLeft: [-71.3, 46.9],
      topRight: [-71.2, 46.9],
      bottomRight: [-71.2, 46.8],
      bottomLeft: [-71.3, 46.8],
    },
  },
  bbox: { minLng: -71.3, minLat: 46.8, maxLng: -71.2, maxLat: 46.9 },
};

const nameOf = (id: string) => useLibraryStore.getState().maps.find((m) => m.id === id)?.name;

beforeEach(() => {
  storage.writeIndex.mockClear();
  // `hydrated` gates persist() — the store never writes an index it built from
  // the empty initial state.
  useLibraryStore.setState({
    hydrated: true,
    maps: [doc('m1', 'Parc de la Jacques-Cartier'), doc('m2', 'Mont-Sainte-Anne')],
  });
});

it('renameMap replaces the name and persists the index', () => {
  useLibraryStore.getState().renameMap('m1', 'Jacques-Cartier — secteur nord');
  expect(nameOf('m1')).toBe('Jacques-Cartier — secteur nord');
  expect(storage.writeIndex).toHaveBeenCalledTimes(1);
  const written = storage.writeIndex.mock.calls[0]?.[0] as { maps: MapDocument[] };
  expect(written.maps.find((m) => m.id === 'm1')?.name).toBe('Jacques-Cartier — secteur nord');
});

it('renameMap trims surrounding whitespace', () => {
  useLibraryStore.getState().renameMap('m1', '  Sentier des Caps \n');
  expect(nameOf('m1')).toBe('Sentier des Caps');
});

it.each(['', '   ', '\t\n'])('renameMap rejects the blank name %p', (blank) => {
  useLibraryStore.getState().renameMap('m1', blank);
  expect(nameOf('m1')).toBe('Parc de la Jacques-Cartier');
});

it('renameMap leaves every other map untouched', () => {
  useLibraryStore.getState().renameMap('m1', 'Renamed');
  expect(nameOf('m2')).toBe('Mont-Sainte-Anne');
  expect(useLibraryStore.getState().maps).toHaveLength(2);
});

it('renameMap allows a duplicate name — maps are addressed by id', () => {
  useLibraryStore.getState().renameMap('m2', 'Parc de la Jacques-Cartier');
  expect(nameOf('m1')).toBe('Parc de la Jacques-Cartier');
  expect(nameOf('m2')).toBe('Parc de la Jacques-Cartier');
});

it('renameMap keeps the rest of the document (file, pages, georeferences)', () => {
  useLibraryStore.setState({
    maps: [
      {
        ...doc('m1', 'Old'),
        pageCount: 4,
        activePages: [0, 2],
        folderId: 'f1',
        georeferences: [georeference],
      },
    ],
  });
  useLibraryStore.getState().renameMap('m1', 'New');
  expect(useLibraryStore.getState().maps[0]).toMatchObject({
    id: 'm1',
    name: 'New',
    // The rename is index-level: the PDF on disk is never rewritten, so the
    // stored file uri (and the map's georeferencing) must be untouched.
    fileUri: 'file://m1.pdf',
    pageCount: 4,
    activePages: [0, 2],
    folderId: 'f1',
    georeferences: [georeference],
  });
});

it('renameMap on an unknown id is a no-op for the names', () => {
  useLibraryStore.getState().renameMap('nope', 'Ghost');
  expect(nameOf('m1')).toBe('Parc de la Jacques-Cartier');
  expect(nameOf('m2')).toBe('Mont-Sainte-Anne');
});
