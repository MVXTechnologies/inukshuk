import type { MapDocument, TrackSummary, Waypoint } from '@core/models';
import * as storage from '@data/storage';

import { useLibraryStore } from './libraryStore';

jest.mock('@data/storage', () => ({
  ...jest
    .requireActual<typeof import('@data/storageTestMock')>('@data/storageTestMock')
    .documentPathMocks(),
  writeIndex: jest.fn(),
  deleteFileAt: jest.fn(),
}));

const map: MapDocument = {
  id: 'map',
  name: 'Map',
  fileUri: 'file:///doc/maps/map.pdf',
  pageCount: 1,
  georeferences: [],
  activePages: [],
  importedAt: 1,
};
const track: TrackSummary = {
  id: 'track',
  name: 'Track',
  fileUri: 'file:///doc/tracks/track.gpx',
  startedAt: 1,
  stats: {
    distanceM: 0,
    ascentM: 0,
    descentM: 0,
    durationS: 0,
    movingTimeS: 0,
    avgSpeedMps: 0,
    maxSpeedMps: 0,
    pointCount: 0,
  },
  notes: [
    {
      id: 'note',
      distanceM: 0,
      text: 'Note',
      createdAt: 1,
      photoUri: 'file:///doc/photos/note.jpg',
    },
  ],
};
const waypoint: Waypoint = {
  id: 'waypoint',
  latitude: 46,
  longitude: -71,
  label: 'Waypoint',
  createdAt: 1,
  photoUri: 'file:///doc/photos/waypoint.jpg',
};
const actions = [
  {
    name: 'map removal',
    run: () => useLibraryStore.getState().removeMap('map'),
    removed: [map.fileUri],
  },
  {
    name: 'track removal',
    run: () => useLibraryStore.getState().removeTrack('track'),
    removed: [track.fileUri, 'file:///doc/photos/note.jpg'],
  },
  {
    name: 'note replacement',
    run: () =>
      useLibraryStore
        .getState()
        .updateTrackNote('track', 'note', 'New', 'file:///doc/photos/new.jpg'),
    removed: ['file:///doc/photos/note.jpg'],
  },
  {
    name: 'note photo removal',
    run: () => useLibraryStore.getState().updateTrackNote('track', 'note', 'New', null),
    removed: ['file:///doc/photos/note.jpg'],
  },
  {
    name: 'note removal',
    run: () => useLibraryStore.getState().removeTrackNote('track', 'note'),
    removed: ['file:///doc/photos/note.jpg'],
  },
  {
    name: 'waypoint photo replacement',
    run: () =>
      useLibraryStore
        .getState()
        .updateWaypoint('waypoint', { photoUri: 'file:///doc/photos/new.jpg' }),
    removed: ['file:///doc/photos/waypoint.jpg'],
  },
  {
    name: 'waypoint photo removal',
    run: () => useLibraryStore.getState().updateWaypoint('waypoint', { photoUri: '' }),
    removed: ['file:///doc/photos/waypoint.jpg'],
  },
  {
    name: 'waypoint removal',
    run: () => useLibraryStore.getState().removeWaypoint('waypoint'),
    removed: ['file:///doc/photos/waypoint.jpg'],
  },
];

beforeEach(() => {
  jest.resetAllMocks();
  useLibraryStore.setState({
    hydrated: true,
    maps: [map],
    tracks: [track],
    waypoints: [waypoint],
    activeMapId: 'map',
    activeTrackIds: ['track'],
  });
});

it.each(actions)('$name preserves state and referenced files when persistence fails', ({ run }) => {
  const before = useLibraryStore.getState();
  jest.mocked(storage.writeIndex).mockImplementationOnce(() => {
    throw new Error('Disk full');
  });
  expect(run).toThrow('Disk full');
  expect(useLibraryStore.getState()).toBe(before);
  expect(storage.deleteFileAt).not.toHaveBeenCalled();
});

it.each(actions)('$name saves metadata before deleting its old assets', ({ run, removed }) => {
  let persisted = false;
  const persistedAtDeletion: boolean[] = [];
  jest.mocked(storage.writeIndex).mockImplementation(() => {
    persisted = true;
  });
  jest.mocked(storage.deleteFileAt).mockImplementation(() => {
    persistedAtDeletion.push(persisted);
  });
  run();
  expect(jest.mocked(storage.deleteFileAt).mock.calls.map(([uri]) => uri)).toEqual(removed);
  expect(persistedAtDeletion.every(Boolean)).toBe(true);
});

it.each(actions)('$name publishes persisted state even if orphan cleanup fails', ({ run }) => {
  const before = useLibraryStore.getState();
  jest.mocked(storage.deleteFileAt).mockImplementation(() => {
    throw new Error('Delete denied');
  });
  expect(run).not.toThrow();
  expect(storage.writeIndex).toHaveBeenCalledTimes(1);
  expect(useLibraryStore.getState()).not.toBe(before);
});

it.each(actions)(
  '$name leaves files intact when persistence is skipped before hydration',
  ({ run }) => {
    useLibraryStore.setState({ hydrated: false });
    run();
    expect(storage.writeIndex).not.toHaveBeenCalled();
    expect(storage.deleteFileAt).not.toHaveBeenCalled();
  },
);
