import { useLibraryStore } from './libraryStore';
import type { Track } from '@core/models';

jest.mock('@data/storage', () => ({
  ...jest
    .requireActual<typeof import('@data/storageTestMock')>('@data/storageTestMock')
    .documentPathMocks(),
  newId: () => 'n_' + Math.random().toString(36).slice(2, 8),
  deleteFileAt: jest.fn(),
  writeJson: jest.fn(),
  writeIndex: jest.fn(),
}));

const track: Track = {
  id: 't1',
  name: 'T',
  startedAt: 1,
  status: 'finished',
  points: [{ latitude: 0, longitude: 0, time: 0 }],
  stats: {
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
  },
};

it('addTrack seeds initial notes with ids', () => {
  useLibraryStore
    .getState()
    .addTrack(track, 'file://t1.gpx', [{ distanceM: 100, text: 'Lookout' }]);
  const saved = useLibraryStore.getState().tracks.find((t) => t.id === 't1');
  expect(saved?.notes).toHaveLength(1);
  expect(saved?.notes?.[0]?.text).toBe('Lookout');
  expect(saved?.notes?.[0]?.distanceM).toBe(100);
  expect(saved?.notes?.[0]?.id).toBeTruthy();
});

it('addTrack without notes leaves notes key absent', () => {
  useLibraryStore.getState().addTrack({ ...track, id: 't2' }, 'file://t2.gpx');
  const saved = useLibraryStore.getState().tracks.find((t) => t.id === 't2');
  expect(saved).not.toHaveProperty('notes');
});

it('addTrack with empty notes leaves notes key absent', () => {
  useLibraryStore.getState().addTrack({ ...track, id: 't3' }, 'file://t3.gpx', []);
  const saved = useLibraryStore.getState().tracks.find((t) => t.id === 't3');
  expect(saved).not.toHaveProperty('notes');
});
