import type { TrackPoint, TrackStats } from '@core/models';

import { computeTrackStats } from './index';
import { movingModelKey } from './movingTime';
import { refreshMovingStats } from './refreshMoving';

const T0 = 1_700_000_000_000;

/** 1 Hz walk north at 1.3 m/s, standing still for `stopS` in the middle. */
function walkWithStop(stopS: number): TrackPoint[] {
  const pts: TrackPoint[] = [];
  let north = 0;
  for (let i = 0; i <= 600 + stopS; i++) {
    const stopped = i > 300 && i <= 300 + stopS;
    if (i > 0 && !stopped) north += 1.3;
    pts.push({ latitude: 46.8 + north / 111_195, longitude: -71.2, time: T0 + i * 1000 });
  }
  return pts;
}

/** Stats as a pre-#504 build saved them: every step counted, no stamp. */
function legacyStats(points: readonly TrackPoint[]): TrackStats {
  const fresh = computeTrackStats(points);
  const legacy: TrackStats = {
    ...fresh,
    movingTimeS: fresh.durationS,
    avgSpeedMps: fresh.distanceM / fresh.durationS,
  };
  delete legacy.movingModel;
  return legacy;
}

describe('refreshMovingStats', () => {
  it('recomputes legacy stats and only touches the moving fields', () => {
    const pts = walkWithStop(300);
    const legacy = { ...legacyStats(pts), ascentM: 123 };
    const next = refreshMovingStats(legacy, 'hike', pts, []);
    expect(next).not.toBeNull();
    expect(next?.movingModel).toBe(movingModelKey('hike'));
    expect(Math.abs((next?.movingTimeS ?? 0) - 600)).toBeLessThanOrEqual(15);
    expect(next?.avgSpeedMps).toBeCloseTo(1.3, 1);
    // Everything else is the stored value, untouched.
    expect(next?.ascentM).toBe(123);
    expect(next?.distanceM).toBe(legacy.distanceM);
    expect(next?.durationS).toBe(900);
  });

  it('is a no-op when the stamp is current', () => {
    const pts = walkWithStop(60);
    const stats = computeTrackStats(pts, { category: 'run' });
    expect(refreshMovingStats(stats, 'run', pts, [])).toBeNull();
  });

  it('recomputes when the category moved to another profile', () => {
    const pts = walkWithStop(0);
    const stats = computeTrackStats(pts, { category: 'hike' });
    const next = refreshMovingStats(stats, 'bike', pts, []);
    expect(next?.movingModel).toBe(movingModelKey('bike'));
    // 1.3 m/s is below the bike threshold: the whole thing is a stop.
    expect(next?.movingTimeS).toBe(0);
  });

  it('refuses a point list the stats were not computed from', () => {
    const pts = walkWithStop(60);
    expect(refreshMovingStats(legacyStats(pts), 'hike', pts.slice(10), [])).toBeNull();
  });

  it('measures segments separately', () => {
    const a = walkWithStop(0);
    const b = walkWithStop(0).map((p) => ({ ...p, time: p.time + 3_600_000 }));
    const pts = [...a, ...b];
    const next = refreshMovingStats(legacyStats(pts), undefined, pts, [a.length]);
    expect(next?.movingTimeS).toBe(1200);
  });
});
