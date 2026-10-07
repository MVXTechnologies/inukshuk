import type { TrackPoint } from '@core/models';
import {
  analyzeRecordingHealth,
  describeRecordingHealth,
  findRecordingGaps,
  formatGapDuration,
  isFixableByUser,
  type RecordingHealthInput,
} from './recordingHealth';

const T0 = 1_700_000_000_000;
// ~111 m per 0.001° of latitude.
const pt = (sec: number, dLat: number, accuracy = 5): TrackPoint => ({
  latitude: 46.8 + dLat,
  longitude: -71.2,
  time: T0 + sec * 1000,
  accuracy,
});

/** A steady walk: one fix every 5 s, ~5.5 m apart. */
function walk(fromSec: number, toSec: number, fromLat: number): TrackPoint[] {
  const out: TrackPoint[] = [];
  for (let s = fromSec, lat = fromLat; s <= toSec; s += 5, lat += 0.00005) out.push(pt(s, lat));
  return out;
}

const base = (over: Partial<RecordingHealthInput>): RecordingHealthInput => ({
  points: [],
  pauses: [],
  backgroundIntervals: [],
  approximateFixes: 0,
  preciseLocation: true,
  ...over,
});

describe('findRecordingGaps', () => {
  it('ignores an evenly sampled walk', () => {
    expect(findRecordingGaps(walk(0, 600, 0), [], [])).toEqual([]);
  });

  it('ignores a long silence without movement (stationary user, distance filter)', () => {
    expect(findRecordingGaps([pt(0, 0), pt(600, 0.0005)], [], [])).toEqual([]);
  });

  it('ignores a short jump (normal fix jitter)', () => {
    expect(findRecordingGaps([pt(0, 0), pt(60, 0.01)], [], [])).toEqual([]);
  });

  it('flags a long silent span that bridged ground', () => {
    const gaps = findRecordingGaps([pt(0, 0), pt(720, 0.01)], [], []);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.durationMs).toBe(720_000);
    expect(gaps[0]?.distanceM).toBeGreaterThan(1000);
    expect(gaps[0]?.inBackground).toBe(false);
  });

  it('marks a gap that fell mostly in the background', () => {
    const bg = [{ from: T0 + 30_000, to: T0 + 700_000 }];
    expect(findRecordingGaps([pt(0, 0), pt(720, 0.01)], [], bg)[0]?.inBackground).toBe(true);
  });

  it('does not mark a gap only briefly backgrounded', () => {
    const bg = [{ from: T0 + 30_000, to: T0 + 90_000 }];
    expect(findRecordingGaps([pt(0, 0), pt(720, 0.01)], [], bg)[0]?.inBackground).toBe(false);
  });

  it('never counts a span that crosses a pause', () => {
    const pauses = [{ from: T0 + 100_000, to: T0 + 600_000 }];
    expect(findRecordingGaps([pt(0, 0), pt(720, 0.01)], pauses, [])).toEqual([]);
  });

  it('never counts a span containing a zero-length pause marker', () => {
    const pauses = [{ from: T0 + 100_000, to: T0 + 100_000 }];
    expect(findRecordingGaps([pt(0, 0), pt(720, 0.01)], pauses, [])).toEqual([]);
  });
});

describe('analyzeRecordingHealth', () => {
  it('is healthy for a continuous walk', () => {
    const h = analyzeRecordingHealth(base({ points: walk(0, 1200, 0) }));
    expect(h.kind).toBe('healthy');
    expect(describeRecordingHealth(h)).toBeNull();
  });

  it('reports the field bug: screen-off gaps make straight lines', () => {
    // Fixes only when the user woke the phone; 12 min silent in the pocket.
    const points = [...walk(0, 60, 0), ...walk(780, 840, 0.02), ...walk(1500, 1560, 0.04)];
    const bg = [
      { from: T0 + 61_000, to: T0 + 779_000 },
      { from: T0 + 841_000, to: T0 + 1_499_000 },
    ];
    const h = analyzeRecordingHealth(base({ points, backgroundIntervals: bg }));
    expect(h.kind).toBe('background-gap');
    expect(h.gaps).toHaveLength(2);
    expect(h.backgroundGapMs).toBe(1_380_000);
    expect(describeRecordingHealth(h)).toBe(
      'GPS updates stopped for 23 min while the screen was off, so parts of your trail are straight lines.',
    );
    expect(isFixableByUser(h.kind)).toBe(true);
  });

  it('reports a foreground gap as lost signal, not a settings problem', () => {
    const points = [...walk(0, 60, 0), ...walk(300, 360, 0.01)];
    const h = analyzeRecordingHealth(base({ points }));
    expect(h.kind).toBe('signal-gap');
    expect(describeRecordingHealth(h)).toContain('No GPS signal for 4 min');
    expect(isFixableByUser(h.kind)).toBe(false);
  });

  it('reports approximate location from the permission state', () => {
    const h = analyzeRecordingHealth(base({ preciseLocation: false, points: walk(0, 60, 0) }));
    expect(h.kind).toBe('approximate-location');
    expect(describeRecordingHealth(h)).toContain('Precise location is off');
  });

  it('reports approximate location from dropped kilometre-scale fixes', () => {
    const h = analyzeRecordingHealth(
      base({ preciseLocation: null, approximateFixes: 40, points: [pt(0, 0)] }),
    );
    expect(h.kind).toBe('approximate-location');
  });

  it('does not blame approximate location for a few coarse fixes on a good track', () => {
    const h = analyzeRecordingHealth(base({ approximateFixes: 3, points: walk(0, 600, 0) }));
    expect(h.kind).toBe('healthy');
  });

  it('approximate location takes precedence over gaps', () => {
    const points = [pt(0, 0), pt(720, 0.01)];
    const bg = [{ from: T0, to: T0 + 720_000 }];
    const h = analyzeRecordingHealth(
      base({ points, backgroundIntervals: bg, preciseLocation: false }),
    );
    expect(h.kind).toBe('approximate-location');
    expect(h.backgroundGapMs).toBe(720_000);
  });

  it('tolerates a single screen-off blip below the report threshold', () => {
    const points = [pt(0, 0), pt(30, 0.0001), pt(130, 0.003)];
    const bg = [{ from: T0 + 30_000, to: T0 + 130_000 }];
    const h = analyzeRecordingHealth(base({ points, backgroundIntervals: bg }));
    expect(h.gaps).toHaveLength(1);
    expect(h.kind).toBe('healthy');
  });
});

describe('formatGapDuration', () => {
  it.each([
    [45_000, '45 s'],
    [400, '1 s'],
    [12 * 60_000, '12 min'],
    [65 * 60_000, '1 h 05 min'],
    [125 * 60_000, '2 h 05 min'],
  ])('%d ms → %s', (ms, text) => {
    expect(formatGapDuration(ms)).toBe(text);
  });
});
