import { splitHeatRuns } from './runs';

describe('splitHeatRuns', () => {
  const countFor = (hotKeys: Record<string, number>) => (key: string) => hotKeys[key] ?? 1;

  it('one all-cold run for a never-hot trace', () => {
    const runs = splitHeatRuns(['a', 'b', 'c'], countFor({}));
    expect(runs).toEqual([{ startIdx: 0, endIdx: 2, count: 1 }]);
  });

  it('splits cold→hot→cold with shared boundary points', () => {
    const runs = splitHeatRuns(['a', 'a', 'h', 'h', 'h', 'b', 'b'], countFor({ h: 3 }));
    expect(runs).toEqual([
      { startIdx: 0, endIdx: 2, count: 1 },
      { startIdx: 2, endIdx: 5, count: 3 },
      { startIdx: 5, endIdx: 6, count: 1 },
    ]);
  });

  it('keeps the max count over a hot run', () => {
    const runs = splitHeatRuns(['h2', 'h5', 'h2'], countFor({ h2: 2, h5: 5 }));
    expect(runs).toEqual([{ startIdx: 0, endIdx: 2, count: 5 }]);
  });

  it('returns [] for fewer than 2 points', () => {
    expect(splitHeatRuns([], countFor({}))).toEqual([]);
    expect(splitHeatRuns(['a'], countFor({}))).toEqual([]);
  });

  it('merges trailing single-point hot run into cold predecessor', () => {
    const runs = splitHeatRuns(['h', 'a'], countFor({ h: 3 }));
    expect(runs).toEqual([{ startIdx: 0, endIdx: 1, count: 3 }]);
    expect(runs.every((r) => r.endIdx - r.startIdx >= 1)).toBe(true);
  });

  it('merges trailing single-point cold run into hot predecessor', () => {
    const runs = splitHeatRuns(['a', 'a', 'h'], countFor({ h: 2 }));
    expect(runs).toEqual([{ startIdx: 0, endIdx: 2, count: 2 }]);
    expect(runs.every((r) => r.endIdx - r.startIdx >= 1)).toBe(true);
  });
});
