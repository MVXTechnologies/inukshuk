import {
  burstDelays,
  compareCellKey,
  compareTimesMs,
  defaultModelTimeline,
  frameX,
  msForTrackRatio,
  runAgeLabel,
  spacedIndices,
  timelineFromTimeList,
} from './modelTimeline';

const H = 3_600_000;
const T0 = Date.parse('2026-08-09T12:00:00Z');

describe('defaultModelTimeline', () => {
  it('guesses hourly frames across the HRDPS horizon from the current hour', () => {
    const tl = defaultModelTimeline('hrdps', T0 + 25 * 60_000);
    expect(tl.kind).toBe('forecast');
    expect(tl.fromCapabilities).toBe(false);
    expect(tl.framesMs).toHaveLength(49);
    expect(tl.framesMs[0]).toBe(T0);
    expect(tl.framesMs[48]).toBe(T0 + 48 * H);
  });

  it('guesses 85 hourly frames for RDPS (84 h horizon)', () => {
    expect(defaultModelTimeline('rdps', T0).framesMs).toHaveLength(85);
  });

  it('switches GDPS to 3-hourly after +84 h, aligned to the UTC 3 h grid', () => {
    const tl = defaultModelTimeline('gdps', T0);
    const frames = tl.framesMs;
    // Hourly head: 85 frames (0..84 h), then a 3-hourly tail to +240 h.
    expect(frames[84]).toBe(T0 + 84 * H);
    const tail = frames.slice(85);
    expect(tail.length).toBeGreaterThan(0);
    for (let i = 1; i < tail.length; i++) {
      expect((tail[i] ?? 0) - (tail[i - 1] ?? 0)).toBe(3 * H);
    }
    expect(frames[frames.length - 1]).toBe(T0 + 240 * H);
    // Every tail frame sits on the UTC 3-hour grid (real GDPS frames do).
    for (const t of tail) expect(t % (3 * H)).toBe(0);
  });

  it('never exceeds the frame cap', () => {
    expect(defaultModelTimeline('gdps', T0).framesMs.length).toBeLessThanOrEqual(168);
  });
});

describe('timelineFromTimeList', () => {
  const list = [T0 - 6 * H, T0 - 5 * H, T0 - 4 * H, T0, T0 + 1 * H, T0 + 2 * H];

  it('drops forecast hours the run already lived through, keeping the frame in effect', () => {
    const tl = timelineFromTimeList(list, 'forecast', T0 + 30 * 60_000);
    expect(tl?.framesMs[0]).toBe(T0);
    expect(tl?.framesMs).toHaveLength(3);
    expect(tl?.fromCapabilities).toBe(true);
  });

  it('keeps a stale run intact rather than emptying the window', () => {
    const stale = [T0 - 6 * H, T0 - 5 * H];
    const tl = timelineFromTimeList(stale, 'forecast', T0);
    expect(tl?.framesMs).toEqual(stale);
  });

  it('keeps the full window for past (radar) timelines', () => {
    const tl = timelineFromTimeList(list, 'past', T0 + 30 * 60_000);
    expect(tl?.framesMs).toEqual(list);
  });

  it('preserves uneven GDPS steps verbatim', () => {
    const uneven = [T0, T0 + H, T0 + 2 * H, T0 + 5 * H, T0 + 8 * H];
    const tl = timelineFromTimeList(uneven, 'forecast', T0 - H);
    expect(tl?.framesMs).toEqual(uneven);
  });

  it('returns null on degenerate lists', () => {
    expect(timelineFromTimeList([], 'forecast', T0)).toBeNull();
    expect(timelineFromTimeList([T0], 'forecast', T0)).toBeNull();
  });
});

describe('frameX / msForTrackRatio (time-proportional track geometry)', () => {
  const uneven = [T0, T0 + H, T0 + 2 * H, T0 + 4 * H]; // 4 h span

  it('positions frames linearly in TIME, not index', () => {
    expect(frameX(uneven, 0, 100)).toBe(0);
    expect(frameX(uneven, 1, 100)).toBe(25);
    expect(frameX(uneven, 2, 100)).toBe(50);
    expect(frameX(uneven, 3, 100)).toBe(100);
  });

  it('is inverse to msForTrackRatio', () => {
    expect(msForTrackRatio(uneven, 0.5)).toBe(T0 + 2 * H);
    expect(msForTrackRatio(uneven, 0)).toBe(T0);
    expect(msForTrackRatio(uneven, 1)).toBe(T0 + 4 * H);
    expect(msForTrackRatio(uneven, 2)).toBe(T0 + 4 * H); // clamped
    expect(msForTrackRatio(uneven, -1)).toBe(T0); // clamped
  });

  it('degrades safely on degenerate inputs', () => {
    expect(frameX([], 0, 100)).toBe(0);
    expect(frameX([T0], 0, 100)).toBe(0);
    expect(msForTrackRatio([], 0.5)).toBe(0);
  });
});

describe('spacedIndices', () => {
  it('thins dense ticks to the minimum pixel gap, keeping the first', () => {
    expect(spacedIndices([0, 1, 2, 6, 7, 12], 3)).toEqual([0, 3, 5]);
  });

  it('keeps everything when already sparse', () => {
    expect(spacedIndices([0, 10, 20], 3)).toEqual([0, 1, 2]);
  });

  it('handles empty input', () => {
    expect(spacedIndices([], 3)).toEqual([]);
  });
});

describe('compareTimesMs', () => {
  it('builds 17 columns of 3-hourly UTC steps from the step covering now', () => {
    const times = compareTimesMs(T0 + 70 * 60_000); // 13:10 UTC
    expect(times).toHaveLength(17);
    expect(times[0]).toBe(T0); // floor to 12:00Z
    expect(times[16]).toBe(T0 + 48 * H);
    for (const t of times) expect(t % (3 * H)).toBe(0);
  });
});

describe('burstDelays', () => {
  it('fires the burst immediately, then paces at the refill interval', () => {
    expect(burstDelays(9, 6, 1000)).toEqual([0, 0, 0, 0, 0, 0, 1000, 2000, 3000]);
  });

  it('handles counts under the burst', () => {
    expect(burstDelays(2, 6, 1000)).toEqual([0, 0]);
  });
});

describe('compareCellKey', () => {
  it('quantizes the point so nearby reopenings share a cache entry', () => {
    const a = compareCellKey('L', T0, 46.8131, -71.2079);
    const b = compareCellKey('L', T0, 46.81312, -71.20791);
    expect(a).toBe(b);
    expect(a).toContain('L|');
  });

  it('separates layers and times', () => {
    expect(compareCellKey('A', T0, 1, 2)).not.toBe(compareCellKey('B', T0, 1, 2));
    expect(compareCellKey('A', T0, 1, 2)).not.toBe(compareCellKey('A', T0 + H, 1, 2));
  });
});

describe('runAgeLabel', () => {
  it('formats minutes, hours and days', () => {
    expect(runAgeLabel('2026-08-09T11:30:00Z', T0)).toBe('run 30 min ago');
    expect(runAgeLabel('2026-08-09T06:00:00Z', T0)).toBe('run 6 h ago');
    expect(runAgeLabel('2026-08-06T12:00:00Z', T0)).toBe('run 3 d ago');
  });

  it('never says "0 min"', () => {
    expect(runAgeLabel('2026-08-09T12:00:00Z', T0)).toBe('run 1 min ago');
  });

  it('returns null for junk or future reference times', () => {
    expect(runAgeLabel(null, T0)).toBeNull();
    expect(runAgeLabel('junk', T0)).toBeNull();
    expect(runAgeLabel('2026-08-09T13:00:00Z', T0)).toBeNull();
  });
});
