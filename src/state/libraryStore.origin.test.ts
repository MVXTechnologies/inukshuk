/**
 * Imported-trail origins (#432/#435): `addTracks` persists them, and
 * `removeTracks` (disconnect cleanup) drops many trails in one write.
 */
import type { Track, TrackSummary } from '@core/models';

import { useLibraryStore } from './libraryStore';

jest.mock('@data/storage', () => ({
  ...jest
    .requireActual<typeof import('@data/storageTestMock')>('@data/storageTestMock')
    .documentPathMocks(),
  newId: () => 'r_' + Math.random().toString(36).slice(2, 8),
  deleteFileAt: jest.fn(),
  writeJson: jest.fn(),
  writeIndex: jest.fn(),
}));

const storage = jest.requireMock('@data/storage') as {
  writeIndex: jest.Mock;
  deleteFileAt: jest.Mock;
};

const stats: TrackSummary['stats'] = {
  distanceM: 1000,
  ascentM: 10,
  descentM: 10,
  durationS: 600,
  movingTimeS: 600,
  avgSpeedMps: 1,
  maxSpeedMps: 2,
  pointCount: 2,
};

const summary = (id: string, over: Partial<TrackSummary> = {}): TrackSummary => ({
  id,
  name: id,
  startedAt: 1,
  stats,
  fileUri: `file:///Documents/tracks/${id}.gpx`,
  ...over,
});

beforeEach(() => {
  storage.writeIndex.mockClear();
  storage.deleteFileAt.mockClear();
  useLibraryStore.setState({ hydrated: true, tracks: [], activeTrackIds: [] });
});

it('persists an imported trail with its origin', () => {
  const track: Track = {
    id: 'imp',
    name: 'Run',
    startedAt: 5,
    status: 'finished',
    points: [],
    stats,
    category: 'run',
    origin: { source: 'strava', externalId: '77' },
  };
  useLibraryStore.getState().addTracks([{ track, fileUri: 'file:///x.gpx', notes: [] }]);
  const saved = useLibraryStore.getState().tracks[0];
  expect(saved?.origin).toEqual({ source: 'strava', externalId: '77' });
  const written = storage.writeIndex.mock.calls[0]?.[0] as { tracks: TrackSummary[] };
  expect(written.tracks[0]?.origin).toEqual({ source: 'strava', externalId: '77' });
});

it('leaves a trail without an origin without the field', () => {
  const track: Track = {
    id: 'rec',
    name: 'Rec',
    startedAt: 5,
    status: 'finished',
    points: [],
    stats,
  };
  useLibraryStore.getState().addTracks([{ track, fileUri: 'file:///y.gpx', notes: [] }]);
  expect(useLibraryStore.getState().tracks[0]).not.toHaveProperty('origin');
});

it('removes many trails, their files and overlays in one write', () => {
  useLibraryStore.setState({
    tracks: [
      summary('a', {
        notes: [{ id: 'n', distanceM: 0, text: '', createdAt: 1, photoUri: 'file:///p.jpg' }],
      }),
      summary('b'),
      summary('c'),
    ],
    activeTrackIds: ['a', 'c'],
  });
  useLibraryStore.getState().removeTracks(['a', 'b', 'missing']);
  expect(useLibraryStore.getState().tracks.map((t) => t.id)).toEqual(['c']);
  expect(useLibraryStore.getState().activeTrackIds).toEqual(['c']);
  expect(storage.writeIndex).toHaveBeenCalledTimes(1);
  expect(storage.deleteFileAt.mock.calls.map((c) => c[0])).toEqual([
    'file:///Documents/tracks/a.gpx',
    'file:///p.jpg',
    'file:///Documents/tracks/b.gpx',
  ]);
});

it('does nothing when no id matches', () => {
  useLibraryStore.setState({ tracks: [summary('a')] });
  useLibraryStore.getState().removeTracks(['zzz']);
  expect(storage.writeIndex).not.toHaveBeenCalled();
});
