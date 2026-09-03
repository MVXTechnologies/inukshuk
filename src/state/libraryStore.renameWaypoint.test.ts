import type { Waypoint } from '@core/models';

import { useLibraryStore } from './libraryStore';

jest.mock('@data/storage', () => ({
  newId: () => 'r_' + Math.random().toString(36).slice(2, 8),
  deleteFileAt: jest.fn(),
  writeJson: jest.fn(),
  writeIndex: jest.fn(),
}));

const storage = jest.requireMock('@data/storage') as {
  writeIndex: jest.Mock;
  deleteFileAt: jest.Mock;
};

const waypoint = (id: string, label: string): Waypoint => ({
  id,
  latitude: 46.81,
  longitude: -71.21,
  label,
  createdAt: 1,
});

const labelOf = (id: string) =>
  useLibraryStore.getState().waypoints.find((w) => w.id === id)?.label;

beforeEach(() => {
  storage.writeIndex.mockClear();
  storage.deleteFileAt.mockClear();
  // `hydrated` gates persist() — the store never writes an index it built from
  // the empty initial state.
  useLibraryStore.setState({
    hydrated: true,
    waypoints: [waypoint('w1', 'Waypoint 1'), waypoint('w2', 'Waypoint 2')],
  });
});

it('renameWaypoint replaces the label and persists the index', () => {
  useLibraryStore.getState().renameWaypoint('w1', 'Refuge du Lac');
  expect(labelOf('w1')).toBe('Refuge du Lac');
  expect(storage.writeIndex).toHaveBeenCalledTimes(1);
  const written = storage.writeIndex.mock.calls[0]?.[0] as { waypoints: Waypoint[] };
  expect(written.waypoints.find((w) => w.id === 'w1')?.label).toBe('Refuge du Lac');
});

it('renameWaypoint trims surrounding whitespace', () => {
  useLibraryStore.getState().renameWaypoint('w1', '  Pont de la Chute \n');
  expect(labelOf('w1')).toBe('Pont de la Chute');
});

it.each(['', '   ', '\t\n'])('renameWaypoint rejects the blank label %p', (blank) => {
  useLibraryStore.getState().renameWaypoint('w1', blank);
  expect(labelOf('w1')).toBe('Waypoint 1');
});

it('renameWaypoint leaves every other waypoint untouched', () => {
  useLibraryStore.getState().renameWaypoint('w1', 'Renamed');
  expect(labelOf('w2')).toBe('Waypoint 2');
  expect(useLibraryStore.getState().waypoints).toHaveLength(2);
});

it('renameWaypoint allows a duplicate label — waypoints are addressed by id', () => {
  useLibraryStore.getState().renameWaypoint('w2', 'Waypoint 1');
  expect(labelOf('w1')).toBe('Waypoint 1');
  expect(labelOf('w2')).toBe('Waypoint 1');
});

it('renameWaypoint keeps the rest of the record (position, note, photo, folder)', () => {
  useLibraryStore.setState({
    waypoints: [
      {
        ...waypoint('w1', 'Old'),
        note: 'Water source',
        photoUri: 'file://w1.jpg',
        folderId: 'f1',
      },
    ],
  });
  useLibraryStore.getState().renameWaypoint('w1', 'New');
  expect(useLibraryStore.getState().waypoints[0]).toMatchObject({
    id: 'w1',
    label: 'New',
    latitude: 46.81,
    longitude: -71.21,
    note: 'Water source',
    photoUri: 'file://w1.jpg',
    folderId: 'f1',
    createdAt: 1,
  });
  // A rename is index-level: it must never touch a file on disk.
  expect(storage.deleteFileAt).not.toHaveBeenCalled();
});

it('renameWaypoint on an unknown id is a no-op for the labels', () => {
  useLibraryStore.getState().renameWaypoint('nope', 'Ghost');
  expect(labelOf('w1')).toBe('Waypoint 1');
  expect(labelOf('w2')).toBe('Waypoint 2');
});

it('a renamed waypoint stops taking part in the "Waypoint N" auto-numbering', () => {
  // "Waypoint 2" renamed away leaves 1 as the highest auto label, so the next
  // drop is "Waypoint 2" again — still unique, because nothing holds that name.
  useLibraryStore.getState().renameWaypoint('w2', 'Camp');
  const id = useLibraryStore.getState().addWaypoint(46.9, -71.3);
  expect(labelOf(id)).toBe('Waypoint 2');
  expect(useLibraryStore.getState().waypoints.map((w) => w.label)).toEqual([
    'Waypoint 1',
    'Camp',
    'Waypoint 2',
  ]);
});
