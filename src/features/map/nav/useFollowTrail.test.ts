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
    expect(result.current).toMatchObject({ name: 'Sentier des Crêtes', readout: null });
    // The trail's own line is ready before the first fix (one line, no pause).
    expect(result.current?.path).toHaveLength(1);
  });

  it('stops, and says so, when the trail cannot be read', async () => {
    mockRead.mockResolvedValue(null);
    useNavigationStore.getState().follow({ trackId: 't1', name: 'X' });
    const { onMessage } = await mount();
    await waitFor(() => expect(useNavigationStore.getState().following).toBeNull());
    expect(onMessage).toHaveBeenCalledWith("Couldn't read that trail to follow it");
  });

  it('keeps your progress on an out-and-back when a waypoint is added mid-follow', async () => {
    // Out 1000 m east, back 6 m north of it: the two legs are closer than GPS noise.
    const outAndBack = polyline(
      [
        [0, 0],
        [1000, 0],
        [1000, 6],
        [0, 6],
      ],
      5,
    );
    mockRead.mockResolvedValue({ points: outAndBack, segmentStarts: [] });
    useNavigationStore.getState().follow({ trackId: 't1', name: 'X' });
    const { result, rerender } = await mount(at(0, 0));
    await waitFor(() => expect(result.current?.readout).not.toBeNull());
    // Walk out and most of the way back.
    for (let x = 0; x <= 1000; x += 20) await rerender({ loc: at(x, 0) });
    for (let x = 1000; x >= 500; x -= 20) await rerender({ loc: at(x, 6) });
    // A noisy fix between the legs, nearer the OUTBOUND one: still on the way back.
    const between = at(500, 2);
    await rerender({ loc: between });
    const before = result.current?.readout?.alongM ?? 0;
    expect(before).toBeGreaterThan(1400);
    // Drop a waypoint just ahead on the way back (before Camp lac, at x = 400).
    await act(async () =>
      useLibraryStore.setState((s) => ({
        waypoints: [...s.waypoints, { id: 'w2', label: 'Ruisseau', createdAt: 0, ...at(450, 6) }],
      })),
    );
    await rerender({ loc: between });
    // Same place on the trail — not snapped to the outbound leg 1000 m earlier…
    expect(result.current?.readout?.alongM).toBeCloseTo(before, 6);
    // …and the new waypoint is the next target straight away.
    expect(result.current?.readout?.target.name).toBe('Ruisseau');
  });

  it('stops when the followed trail is deleted', async () => {
    useNavigationStore.getState().follow({ trackId: 't1', name: 'X' });
    const { result } = await mount();
    await waitFor(() => expect(result.current?.readout).not.toBeNull());
    await act(async () => seed([]));
    expect(useNavigationStore.getState().following).toBeNull();
  });
});
