import * as storage from '@data/storage';

import { useLibraryStore } from './libraryStore';

jest.mock('@data/storage', () => ({
  newId: () => 'w_' + Math.random().toString(36).slice(2, 8),
  deleteFileAt: jest.fn(),
  writeIndex: jest.fn(),
}));

const wp = (id: string) => useLibraryStore.getState().waypoints.find((w) => w.id === id);

beforeEach(() => {
  useLibraryStore.setState({ waypoints: [] });
});

it('addWaypoint stores the position with an auto label and returns the id', () => {
  const id = useLibraryStore.getState().addWaypoint(46.81, -71.21);
  const saved = wp(id);
  expect(saved).toMatchObject({ latitude: 46.81, longitude: -71.21, label: 'Waypoint 1' });
  expect(saved?.createdAt).toBeGreaterThan(0);
  expect(saved).not.toHaveProperty('note');
  expect(saved).not.toHaveProperty('photoUri');
});

it('auto labels number past deletions, never minting a duplicate', () => {
  const store = useLibraryStore.getState();
  const first = store.addWaypoint(1, 1);
  store.addWaypoint(2, 2); // "Waypoint 2"
  useLibraryStore.getState().removeWaypoint(first);
  const third = useLibraryStore.getState().addWaypoint(3, 3);
  expect(wp(third)?.label).toBe('Waypoint 3');
});

it('updateWaypoint edits the note without touching the position', () => {
  const id = useLibraryStore.getState().addWaypoint(46, -71);
  useLibraryStore.getState().updateWaypoint(id, { note: 'Great lookout' });
  expect(wp(id)).toMatchObject({ note: 'Great lookout', latitude: 46, longitude: -71 });
});

it('updateWaypoint replacing a photo deletes the orphaned file', () => {
  const id = useLibraryStore.getState().addWaypoint(46, -71);
  useLibraryStore.getState().updateWaypoint(id, { photoUri: 'file://a.jpg' });
  useLibraryStore.getState().updateWaypoint(id, { photoUri: 'file://b.jpg' });
  expect(storage.deleteFileAt).toHaveBeenCalledWith('file://a.jpg');
  expect(wp(id)?.photoUri).toBe('file://b.jpg');
});

it("updateWaypoint with photoUri '' removes the photo and deletes its file", () => {
  const id = useLibraryStore.getState().addWaypoint(46, -71);
  useLibraryStore.getState().updateWaypoint(id, { photoUri: 'file://a.jpg' });
  useLibraryStore.getState().updateWaypoint(id, { photoUri: '' });
  expect(storage.deleteFileAt).toHaveBeenCalledWith('file://a.jpg');
  expect(wp(id)).not.toHaveProperty('photoUri');
});

it('removeWaypoint drops the waypoint and deletes its photo', () => {
  const id = useLibraryStore.getState().addWaypoint(46, -71);
  useLibraryStore.getState().updateWaypoint(id, { photoUri: 'file://c.jpg' });
  useLibraryStore.getState().removeWaypoint(id);
  expect(wp(id)).toBeUndefined();
  expect(storage.deleteFileAt).toHaveBeenCalledWith('file://c.jpg');
});
