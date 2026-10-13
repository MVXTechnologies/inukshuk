import type { LatLng, TrackSummary } from '@core/models';
import { at, polyline } from '@core/nav/__fixtures__/paths';
import { useLibraryStore } from '@state/libraryStore';
import { useNavigationStore } from '@state/navigationStore';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useFollowTrail } from './useFollowTrail';

const mockRead = jest.fn();
jest.mock('@data/trailStatsStore', () => ({
  readTrailPoints: (t: unknown) => mockRead(t),
}));

const TRAIL = polyline(
  [
    [0, 0],
    [1000, 0],
  ],
  5,
);
const TRACK: TrackSummary = {
  id: 't1',
  name: 'Sentier des Crêtes',
  startedAt: 0,
  fileUri: 'file:///doc/tracks/t1.gpx',
  notes: [{ id: 'n1', distanceM: 800, text: 'Lookout', createdAt: 0 }],
  stats: {
    distanceM: 1000,
    ascentM: 0,
    descentM: 0,
    durationS: 0,
    movingTimeS: 0,
    avgSpeedMps: 0,
    maxSpeedMps: 0,
    pointCount: TRAIL.length,
  },
};

function seed(tracks: TrackSummary[] = [TRACK]) {
  useLibraryStore.setState({
    hydrated: true,
    tracks,
    waypoints: [
      { id: 'w1', label: 'Camp lac', createdAt: 0, ...at(400, 10) },
      { id: 'far', label: 'Elsewhere', createdAt: 0, ...at(400, 900) },
    ],
  });
}

beforeEach(() => {
  mockRead.mockReset();
  mockRead.mockResolvedValue({ points: TRAIL, segmentStarts: [] });
  useNavigationStore.setState({ destination: null, following: null });
  seed();
});

async function mount(location: LatLng | null = at(100, 2)) {
  const onMessage = jest.fn();
  const hook = await renderHook(
    ({ loc }: { loc: LatLng | null }) => useFollowTrail(loc, onMessage),
    {
      initialProps: { loc: location },
    },
  );
  return { ...hook, onMessage };
}

describe('useFollowTrail', () => {
  it('is null while nothing is followed', async () => {
    const { result } = await mount();
    expect(result.current).toBeNull();
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('loads the trail once and guides to the next waypoint on it', async () => {
    useNavigationStore.getState().follow({ trackId: 't1', name: 'Sentier des Crêtes' });
    const { result, rerender } = await mount();
    await waitFor(() => expect(result.current?.readout).not.toBeNull());
    expect(result.current?.name).toBe('Sentier des Crêtes');
    expect(result.current?.readout?.target.name).toBe('Camp lac');
    expect(result.current?.readout?.onTrail).toBe(true);
    // Past the waypoint: the note, then the end.
    await rerender({ loc: at(500, 0) });
    expect(result.current?.readout?.target.name).toBe('Lookout');
    await rerender({ loc: at(900, 0) });
    expect(result.current?.readout?.target.kind).toBe('end');
    expect(mockRead).toHaveBeenCalledTimes(1);
  });

  it('has no readout without a fix', async () => {
    useNavigationStore.getState().follow({ trackId: 't1', name: 'X' });
    const { result } = await mount(null);
    await waitFor(() => expect(mockRead).toHaveBeenCalled());
    expect(result.current).toEqual({ name: 'Sentier des Crêtes', readout: null });
  });

  it('stops, and says so, when the trail cannot be read', async () => {
    mockRead.mockResolvedValue(null);
    useNavigationStore.getState().follow({ trackId: 't1', name: 'X' });
    const { onMessage } = await mount();
    await waitFor(() => expect(useNavigationStore.getState().following).toBeNull());
    expect(onMessage).toHaveBeenCalledWith("Couldn't read that trail to follow it");
  });

  it('stops when the followed trail is deleted', async () => {
    useNavigationStore.getState().follow({ trackId: 't1', name: 'X' });
    const { result } = await mount();
    await waitFor(() => expect(result.current?.readout).not.toBeNull());
    await act(async () => seed([]));
    expect(useNavigationStore.getState().following).toBeNull();
  });
});
