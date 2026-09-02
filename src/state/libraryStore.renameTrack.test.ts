import type { TrackSummary } from '@core/models';

import { useLibraryStore } from './libraryStore';

jest.mock('@data/storage', () => ({
  newId: () => 'r_' + Math.random().toString(36).slice(2, 8),
  deleteFileAt: jest.fn(),
  writeJson: jest.fn(),
  writeIndex: jest.fn(),
}));

const storage = jest.requireMock('@data/storage') as { writeIndex: jest.Mock };

const stats: TrackSummary['stats'] = {
  distanceM: 0,
  ascentM: 0,
  descentM: 0,
  durationS: 0,
  movingTimeS: 0,
  avgSpeedMps: 0,
  maxSpeedMps: 0,
  minAltitudeM: undefined,
  maxAltitudeM: undefined,
  bbox: undefined,
  pointCount: 1,
};

const summary = (id: string, name: string): TrackSummary => ({
  id,
  name,
  startedAt: 1,
  stats,
  fileUri: `file://${id}.gpx`,
});

const nameOf = (id: string) => useLibraryStore.getState().tracks.find((t) => t.id === id)?.name;

beforeEach(() => {
  storage.writeIndex.mockClear();
  // `hydrated` gates persist() — the store never writes an index it built from
  // the empty initial state.
  useLibraryStore.setState({
    hydrated: true,
    tracks: [summary('t1', 'Morning run'), summary('t2', 'Evening hike')],
  });
});

it('renameTrack replaces the name and persists the index', () => {
  useLibraryStore.getState().renameTrack('t1', 'Mont-Royal loop');
  expect(nameOf('t1')).toBe('Mont-Royal loop');
  expect(storage.writeIndex).toHaveBeenCalledTimes(1);
  const written = storage.writeIndex.mock.calls[0]?.[0] as { tracks: TrackSummary[] };
  expect(written.tracks.find((t) => t.id === 't1')?.name).toBe('Mont-Royal loop');
});

it('renameTrack trims surrounding whitespace', () => {
  useLibraryStore.getState().renameTrack('t1', '  Sentier des Caps \n');
  expect(nameOf('t1')).toBe('Sentier des Caps');
});

it.each(['', '   ', '\t\n'])('renameTrack rejects the blank name %p', (blank) => {
  useLibraryStore.getState().renameTrack('t1', blank);
  expect(nameOf('t1')).toBe('Morning run');
});

it('renameTrack leaves every other trail untouched', () => {
  useLibraryStore.getState().renameTrack('t1', 'Renamed');
  expect(nameOf('t2')).toBe('Evening hike');
  expect(useLibraryStore.getState().tracks).toHaveLength(2);
});

it('renameTrack allows a duplicate name — trails are addressed by id', () => {
  useLibraryStore.getState().renameTrack('t2', 'Morning run');
  expect(nameOf('t1')).toBe('Morning run');
  expect(nameOf('t2')).toBe('Morning run');
});

it('renameTrack keeps the rest of the summary (file, stats, notes)', () => {
  useLibraryStore.setState({
    tracks: [
      {
        ...summary('t1', 'Old'),
        notes: [{ id: 'n1', text: 'Lookout', distanceM: 10, createdAt: 5 }],
      },
    ],
  });
  useLibraryStore.getState().renameTrack('t1', 'New');
  expect(useLibraryStore.getState().tracks[0]).toMatchObject({
    id: 't1',
    name: 'New',
    fileUri: 'file://t1.gpx',
    notes: [{ id: 'n1', text: 'Lookout', distanceM: 10 }],
  });
});

it('renameTrack on an unknown id is a no-op for the names', () => {
  useLibraryStore.getState().renameTrack('nope', 'Ghost');
  expect(nameOf('t1')).toBe('Morning run');
  expect(nameOf('t2')).toBe('Evening hike');
});
