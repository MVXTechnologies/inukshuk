import { CLIMB_MODEL_KEY, computeTrackStats, movingModelKey } from '@core/geo/track';
import type { TrackPoint, TrackStats, TrackSummary } from '@core/models';
import { useLibraryStore } from '@state/libraryStore';
import { renderHook } from '@testing-library/react-native';
import { useLazyMovingStats } from './useLazyMovingStats';

const T0 = 1_700_000_000_000;

/** 1 Hz walk at 1.3 m/s with a 5-minute stop in the middle. */
const POINTS: TrackPoint[] = Array.from({ length: 901 }, (_, i) => {
  const moved = Math.min(i, 300) + Math.max(0, i - 600);
  return { latitude: 46.8 + (moved * 1.3) / 111_195, longitude: -71.2, time: T0 + i * 1000 };
});

function summary(stats: TrackStats, category?: string): TrackSummary {
  return { id: 't1', name: 'Walk', startedAt: T0, stats, fileUri: 'file:///t1.gpx', category };
}

/** What a pre-#504 build stored: every second "moving", no stamp. */
function legacy(): TrackStats {
  const s: TrackStats = { ...computeTrackStats(POINTS), movingTimeS: 900 };
  delete s.movingModel;
  return s;
}

const updateTrack = jest.fn();
beforeEach(() => {
  updateTrack.mockReset();
  useLibraryStore.setState({ updateTrack });
});

describe('useLazyMovingStats (#504)', () => {
  it('waits for the points, then persists recomputed moving stats once', async () => {
    const track = summary(legacy(), 'hike');
    const view = await renderHook(
      ({ pts }: { pts: TrackPoint[] | null }) => useLazyMovingStats(track, pts, []),
      { initialProps: { pts: null as TrackPoint[] | null } },
    );
    expect(updateTrack).not.toHaveBeenCalled();
    await view.rerender({ pts: POINTS });
    expect(updateTrack).toHaveBeenCalledTimes(1);
    const [id, patch] = updateTrack.mock.calls[0] as [string, { stats: TrackStats }];
    expect(id).toBe('t1');
    expect(patch.stats.movingModel).toBe(movingModelKey('hike'));
    expect(Math.abs(patch.stats.movingTimeS - 600)).toBeLessThanOrEqual(15);
  });

  it('does nothing for a trail whose moving stats are current', async () => {
    const track = summary(
      computeTrackStats(POINTS, { category: 'hike', robustClimb: true }),
      'hike',
    );
    await renderHook(() => useLazyMovingStats(track, POINTS, []));
    expect(updateTrack).not.toHaveBeenCalled();
  });

  it('recomputes after the trail is re-filed under another activity', async () => {
    const stats = computeTrackStats(POINTS, { category: 'hike', robustClimb: true });
    const view = await renderHook(
      ({ cat }: { cat: string }) => useLazyMovingStats(summary(stats, cat), POINTS, []),
      { initialProps: { cat: 'hike' } },
    );
    expect(updateTrack).not.toHaveBeenCalled();
    await view.rerender({ cat: 'bike' });
    expect(updateTrack).toHaveBeenCalledTimes(1);
  });

  it('upgrades the climb of a trail saved before the climb rule, in the same write', async () => {
    // A traverse whose elevations hop between two terrain pixels 10 m apart.
    const hopping = POINTS.map((p, i) => ({ ...p, altitude: i % 6 < 3 ? 1000 : 1010 }));
    const stale = computeTrackStats(hopping, { category: 'hike' });
    expect(stale.climbModel).toBeUndefined();
    await renderHook(() => useLazyMovingStats(summary(stale, 'hike'), hopping, []));
    expect(updateTrack).toHaveBeenCalledTimes(1);
    const [, patch] = updateTrack.mock.calls[0] as [string, { stats: TrackStats }];
    expect(patch.stats.climbModel).toBe(CLIMB_MODEL_KEY);
    expect(stale.ascentM).toBeGreaterThan(1000);
    expect(patch.stats.ascentM).toBeLessThan(20);
    expect(patch.stats.movingModel).toBe(movingModelKey('hike'));
  });

  it('keeps the drawing tool’s climb on a drawn route', async () => {
    const stats = computeTrackStats(POINTS, { category: 'hike' });
    const track: TrackSummary = {
      ...summary(stats, 'hike'),
      plan: { mode: 'freehand', vertices: [] },
    };
    await renderHook(() => useLazyMovingStats(track, POINTS, []));
    expect(updateTrack).not.toHaveBeenCalled();
  });

  it('ignores a point list that is not the stored trail (mid-trim reload)', async () => {
    await renderHook(() => useLazyMovingStats(summary(legacy()), POINTS.slice(100), []));
    expect(updateTrack).not.toHaveBeenCalled();
  });
});
