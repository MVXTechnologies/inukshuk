import { percentileOf, stallStats } from './stallStats';

describe('stallStats', () => {
  it('reports nothing for an on-time heartbeat', () => {
    const beats = Array.from({ length: 20 }, (_, i) => i * 16);
    expect(stallStats(beats, 16)).toEqual({ beats: 20, blockedMs: 0, maxGapMs: 16, longTasks: 0 });
  });

  it('counts the lateness of each long stall', () => {
    // On time, then a 516 ms gap (500 late), on time, a 216 ms gap (200 late), a 40 ms hiccup.
    const beats = [0, 16, 532, 548, 764, 804];
    expect(stallStats(beats, 16)).toEqual({
      beats: 6,
      blockedMs: 700,
      maxGapMs: 516,
      longTasks: 2,
    });
  });

  it('handles empty and single-beat input', () => {
    expect(stallStats([], 16).blockedMs).toBe(0);
    expect(stallStats([5], 16)).toEqual({ beats: 1, blockedMs: 0, maxGapMs: 0, longTasks: 0 });
  });
});

describe('percentileOf', () => {
  it('uses nearest rank', () => {
    expect(percentileOf([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentileOf([5, 1, 3, 2, 4], 100)).toBe(5);
    expect(percentileOf([5, 1, 3, 2, 4], 0)).toBe(1);
    expect(percentileOf([], 50)).toBeNaN();
  });
});
