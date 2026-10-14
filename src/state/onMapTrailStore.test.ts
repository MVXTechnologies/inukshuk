/**
 * "On map" (#710): the trail is a look over the Library's shown set, never a
 * write to it, so ✕ gives the map its previous set back; a deliberate change
 * to that set ends the look.
 */
import { useLibraryStore } from './libraryStore';
import { useOnMapTrailStore } from './onMapTrailStore';

jest.mock('@data/storage', () => ({
  ...jest
    .requireActual<typeof import('@data/storageTestMock')>('@data/storageTestMock')
    .documentPathMocks(),
  newId: () => 'n_' + Math.random().toString(36).slice(2, 8),
  ensureStorage: jest.fn(),
  deleteFileAt: jest.fn(),
  deleteDocumentFile: jest.fn(),
  writeJson: jest.fn(),
  writeIndex: jest.fn(),
  readIndex: jest.fn(),
}));

const storage = jest.requireMock('@data/storage') as {
  writeIndex: jest.Mock;
  readIndex: jest.Mock;
};

const stats = {
  distanceM: 0,
  ascentM: 0,
  descentM: 0,
  durationS: 0,
  movingTimeS: 0,
  avgSpeedMps: 0,
  maxSpeedMps: 0,
  pointCount: 1,
};
const track = (id: string) => ({ id, name: id, startedAt: 1, stats, fileUri: `file://${id}.gpx` });

beforeAll(async () => {
  storage.readIndex.mockResolvedValue({
    maps: [],
    tracks: [track('t1'), track('t2'), track('t3')],
    folders: [],
    activeMapId: null,
    activeTrackIds: ['t2', 't3'],
  });
  await useLibraryStore.getState().hydrate();
});

beforeEach(() => {
  useLibraryStore.getState().setActiveTrackIds(['t2', 't3']);
  useOnMapTrailStore.getState().close();
  storage.writeIndex.mockClear();
});

it('shows a trail without touching the Library set or writing the index', () => {
  useOnMapTrailStore.getState().show('t1');
  expect(useOnMapTrailStore.getState().trackId).toBe('t1');
  expect(useLibraryStore.getState().activeTrackIds).toEqual(['t2', 't3']);
  expect(storage.writeIndex).not.toHaveBeenCalled();
});

it('✕ gives the map the previous set back', () => {
  useOnMapTrailStore.getState().show('t1');
  useOnMapTrailStore.getState().close();
  expect(useOnMapTrailStore.getState().trackId).toBeNull();
  expect(useLibraryStore.getState().activeTrackIds).toEqual(['t2', 't3']);
});

it('a second "On map" replaces the first', () => {
  useOnMapTrailStore.getState().show('t1');
  useOnMapTrailStore.getState().show('t2');
  expect(useOnMapTrailStore.getState().trackId).toBe('t2');
});

it('an eye toggle in the Library ends the look (the user took the map back)', () => {
  useOnMapTrailStore.getState().show('t1');
  useLibraryStore.getState().toggleTrackOverlay('t1');
  expect(useOnMapTrailStore.getState().trackId).toBeNull();
  // …and the eye toggle is persistent, as before.
  expect(useLibraryStore.getState().activeTrackIds).toEqual(['t2', 't3', 't1']);
});

it('"View on map" in the Library ends the look', () => {
  useOnMapTrailStore.getState().show('t1');
  useLibraryStore.getState().setActiveTrackIds(['t3']);
  expect(useOnMapTrailStore.getState().trackId).toBeNull();
});

it('a write that leaves the same set (reordered or unchanged) keeps the look', () => {
  useOnMapTrailStore.getState().show('t1');
  useLibraryStore.getState().setActiveTrackIds(['t3', 't2']);
  expect(useOnMapTrailStore.getState().trackId).toBe('t1');
  // Renaming a trail rewrites the library, not the shown set.
  useLibraryStore.getState().renameTrack('t1', 'Renamed');
  expect(useOnMapTrailStore.getState().trackId).toBe('t1');
});
