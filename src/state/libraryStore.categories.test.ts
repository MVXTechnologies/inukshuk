import { LIBRARY_SCHEMA_VERSION } from '@core/library/migrations';
import { useLibraryStore } from './libraryStore';

jest.mock('@data/storage', () => {
  let n = 0;
  return {
    newId: () => `id_${++n}`,
    ensureStorage: jest.fn(),
    deleteFileAt: jest.fn(),
    writeJson: jest.fn(),
    writeIndex: jest.fn(),
    readIndex: jest.fn(),
  };
});

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
    schemaVersion: 2, // pre-categories index — migration seeds customCategories
    maps: [],
    tracks: [track('t1'), track('t2')],
    bundles: [],
    folders: [],
    activeMapId: null,
    activeTrackIds: [],
  });
  await useLibraryStore.getState().hydrate();
});

it('hydrating a pre-categories index starts with no custom categories', () => {
  expect(useLibraryStore.getState().customCategories).toEqual([]);
});

it('addCustomCategory appends, trims the name, and persists', () => {
  const id = useLibraryStore.getState().addCustomCategory('  Canoe  ', '#C74FA0');
  const custom = useLibraryStore.getState().customCategories;
  expect(custom).toHaveLength(1);
  expect(custom[0]).toMatchObject({ id, name: 'Canoe', color: '#C74FA0' });
  expect(storage.writeIndex).toHaveBeenLastCalledWith(
    expect.objectContaining({
      schemaVersion: LIBRARY_SCHEMA_VERSION,
      customCategories: [expect.objectContaining({ id, name: 'Canoe' })],
    }),
  );
});

it('setTrackCategory sets, replaces and clears a trail category (persisted)', () => {
  const s = useLibraryStore.getState();
  s.setTrackCategory('t1', 'hike');
  expect(useLibraryStore.getState().tracks.find((t) => t.id === 't1')?.category).toBe('hike');

  useLibraryStore.getState().setTrackCategory('t1', 'bike');
  expect(useLibraryStore.getState().tracks.find((t) => t.id === 't1')?.category).toBe('bike');
  // Only the targeted trail changes.
  expect(useLibraryStore.getState().tracks.find((t) => t.id === 't2')?.category).toBeUndefined();

  useLibraryStore.getState().setTrackCategory('t1', null);
  expect(useLibraryStore.getState().tracks.find((t) => t.id === 't1')?.category).toBeUndefined();
  expect(storage.writeIndex).toHaveBeenLastCalledWith(
    expect.objectContaining({
      tracks: expect.arrayContaining([expect.objectContaining({ id: 't1' })]),
    }),
  );
});
