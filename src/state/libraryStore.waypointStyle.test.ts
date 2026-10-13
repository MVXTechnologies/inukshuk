import * as storage from '@data/storage';
import { migrateLibraryIndex } from '@core/library/migrations';

import { useLibraryStore } from './libraryStore';

jest.mock('@data/storage', () => ({
  ...jest
    .requireActual<typeof import('@data/storageTestMock')>('@data/storageTestMock')
    .documentPathMocks(),
  newId: () => 'w_' + Math.random().toString(36).slice(2, 8),
  deleteFileAt: jest.fn(),
  writeIndex: jest.fn(),
}));

const wp = (id: string) => useLibraryStore.getState().waypoints.find((w) => w.id === id);

beforeEach(() => {
  useLibraryStore.setState({ hydrated: true, waypoints: [] });
  jest.mocked(storage.writeIndex).mockClear();
});

describe('waypoint colour and size (#675)', () => {
  it('stores a colour (upper-cased) and a size, and null restores the defaults', () => {
    const id = useLibraryStore.getState().addWaypoint(46, -71);
    useLibraryStore
      .getState()
      .updateWaypoint(id, { color: '#e8612c', size: 'L', icon: 'campfire' });
    expect(wp(id)).toMatchObject({ color: '#E8612C', size: 'L', icon: 'campfire' });
    useLibraryStore.getState().updateWaypoint(id, { color: null, size: null });
    expect(wp(id)).not.toHaveProperty('color');
    expect(wp(id)).not.toHaveProperty('size');
    expect(wp(id)?.icon).toBe('campfire');
  });

  it('drops a value that is not a colour or a size', () => {
    const id = useLibraryStore.getState().addWaypoint(46, -71);
    useLibraryStore.getState().updateWaypoint(id, { color: 'red', size: 'XXL' as never });
    expect(wp(id)).not.toHaveProperty('color');
    expect(wp(id)).not.toHaveProperty('size');
  });
});

describe('moveWaypoint (#676)', () => {
  it('changes only the coordinate, and persists', () => {
    const id = useLibraryStore.getState().addWaypoint(46, -71, 'Camp lac');
    useLibraryStore.getState().updateWaypoint(id, { note: 'Sandy', color: '#1E64C8' });
    const before = wp(id);
    jest.mocked(storage.writeIndex).mockClear();
    useLibraryStore.getState().moveWaypoint(id, 46.001, -71.002);
    expect(wp(id)).toEqual({ ...before, latitude: 46.001, longitude: -71.002 });
    expect(storage.writeIndex).toHaveBeenCalledTimes(1);
  });

  it('refuses a coordinate that is not on Earth', () => {
    const id = useLibraryStore.getState().addWaypoint(46, -71);
    jest.mocked(storage.writeIndex).mockClear();
    useLibraryStore.getState().moveWaypoint(id, 95, -71);
    useLibraryStore.getState().moveWaypoint(id, Number.NaN, -71);
    expect(wp(id)).toMatchObject({ latitude: 46, longitude: -71 });
    expect(storage.writeIndex).not.toHaveBeenCalled();
  });
});

describe('library.json (no migration)', () => {
  it('loads an index without the new fields, and drops junk ones', () => {
    const migrated = migrateLibraryIndex({
      schemaVersion: 1,
      maps: [],
      tracks: [],
      waypoints: [
        { id: 'a', latitude: 1, longitude: 2, label: 'A', createdAt: 1 },
        {
          id: 'b',
          latitude: 1,
          longitude: 2,
          label: 'B',
          createdAt: 1,
          icon: 'campfire',
          color: '#abcdef',
          size: 'XL',
        },
        { id: 'c', latitude: 1, longitude: 2, label: 'C', createdAt: 1, color: 7, size: 'huge' },
      ],
    });
    const [a, b, c] = migrated.waypoints;
    expect(a).not.toHaveProperty('color');
    expect(b).toMatchObject({ icon: 'campfire', color: '#ABCDEF', size: 'XL' });
    expect(c).not.toHaveProperty('color');
    expect(c).not.toHaveProperty('size');
  });
});
