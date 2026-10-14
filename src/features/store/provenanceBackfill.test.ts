/**
 * 2.5.2 review: a phone rolled back to 2.5.1 rewrites the Library without the
 * credit fields 2.5.1 does not know. Back on 2.5.2, they return from the
 * catalog as soon as the map's item loads.
 */
import type { CatalogIndex } from '@core/catalog/schema';
import type { MapDocument } from '@core/models';
import { useCatalogStore } from '@state/catalogStore';
import { useLibraryStore } from '@state/libraryStore';

import { cpaIndex, cpaMap, cpaSource } from './explore/exploreTestUtils';
import { installCatalogProvenanceBackfill } from './provenanceBackfill';

jest.mock('@data/storage', () => ({
  ...jest
    .requireActual<typeof import('@data/storageTestMock')>('@data/storageTestMock')
    .documentPathMocks(),
  ensureStorage: jest.fn(),
  readIndex: jest.fn(async () => null),
  writeIndex: jest.fn(),
  newId: jest.fn(() => 'id'),
  deleteFileAt: jest.fn(),
}));
jest.mock('@data/catalogCache', () => ({ loadCatalogManifest: jest.fn(async () => null) }));

/** What 2.5.1 leaves of a Cartes Plein-air download. */
const stripped: MapDocument = {
  id: 'm-cpa',
  name: cpaMap.title,
  fileUri: 'file://maps/m-cpa.pdf',
  importedAt: 1,
  pageCount: 1,
  georeferences: [],
  activePages: [],
  sourceItemId: cpaMap.id,
  ...(cpaMap.updatedAt !== undefined ? { sourceUpdatedAt: cpaMap.updatedAt } : {}),
};

let uninstall: () => void = () => undefined;
afterEach(() => uninstall());

it('puts the credits back once the map’s catalog item loads, then leaves the Library alone', () => {
  useLibraryStore.setState({ maps: [stripped], hydrated: true });
  useCatalogStore.setState({ index: null, items: [] });
  uninstall = installCatalogProvenanceBackfill();
  expect(useLibraryStore.getState().maps[0]?.sourceCredit).toBeUndefined();

  const index: CatalogIndex = cpaIndex();
  useCatalogStore.setState({ index, items: index.items });
  const map = useLibraryStore.getState().maps[0];
  expect(map).toMatchObject({
    sourceCredit: 'Auteur Exemple · 2022',
    sourceFreeAt: cpaSource.freeAt,
    sourcePageUrl: cpaMap.pageUrl,
    sourceVersion: cpaMap.version,
  });

  // Nothing left to fill: a later shard merge writes nothing.
  const updateMap = jest.spyOn(useLibraryStore.getState(), 'updateMap');
  useCatalogStore.setState({ items: [...index.items] });
  expect(updateMap).not.toHaveBeenCalled();
});

it('waits for the Library to be read', () => {
  const index = cpaIndex();
  useCatalogStore.setState({ index, items: index.items });
  useLibraryStore.setState({ maps: [stripped], hydrated: false });
  uninstall = installCatalogProvenanceBackfill();
  expect(useLibraryStore.getState().maps[0]?.sourceCredit).toBeUndefined();
  useLibraryStore.setState({ hydrated: true });
  expect(useLibraryStore.getState().maps[0]?.sourceCredit).toBe('Auteur Exemple · 2022');
});
