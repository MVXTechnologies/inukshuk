import {
  baseLevelIndex,
  contourAt,
  contourLevelsForZoom,
  distanceToLevelPx,
  FULL_SPACING_PX,
  isMajorLevel,
  LEVEL_LADDER,
  levelForDensity,
  lineCoverage,
  MAJOR_WIDTH_PX,
  MIN_SPACING_PX,
  MINOR_WIDTH_PX,
} from './contours3d';

describe('levels by zoom (the 2D ladder)', () => {
  it.each([
    [5, [100, 500]],
    [9.9, [100, 500]],
    [10, [50, 250]],
    [11.5, [25, 100]],
    [12, [20, 100]],
    [13, [10, 50]],
    [17, [10, 50]],
  ])('zoom %p → %p', (z, lv) => {
    expect(contourLevelsForZoom(z)).toEqual(lv);
    expect(LEVEL_LADDER[baseLevelIndex(z)]).toEqual(lv);
  });
  it('every major is a whole multiple of its minor', () => {
    for (const [minor, major] of LEVEL_LADDER) expect(major % minor).toBe(0);
  });
});

describe('density stepping', () => {
  it('keeps the base level while lines are far enough apart', () => {
    expect(levelForDensity(0, 1)).toEqual({ index: 0, finerWeight: 0 }); // 10 px apart
  });
  it('steps up where lines crowd (steep or far)', () => {
    const r = levelForDensity(0, 5); // 10 m every 2 px → too dense
    expect(r.index).toBeGreaterThan(0);
    expect(LEVEL_LADDER[r.index]![0] / 5).toBeGreaterThanOrEqual(MIN_SPACING_PX);
  });
  it('never goes finer than the base', () => {
    expect(levelForDensity(3, 0.01).index).toBe(3);
  });
  it('tops out at the coarsest level', () => {
    expect(levelForDensity(0, 1e6).index).toBe(LEVEL_LADDER.length - 1);
  });
  it.each([0.5, 1, 2, 3, 4, 6, 10, 25, 60, 150])(
    'dh %p m/px: chosen spacing ≥ the minimum',
    (d) => {
      const r = levelForDensity(0, d);
      if (r.index < LEVEL_LADDER.length - 1) {
        expect(LEVEL_LADDER[r.index]![0] / d).toBeGreaterThanOrEqual(MIN_SPACING_PX);
      }
      expect(r.finerWeight).toBeGreaterThanOrEqual(0);
      expect(r.finerWeight).toBeLessThanOrEqual(1);
    },
  );
  it('the finer level fades continuously as density rises (no step)', () => {
    let prev = -1;
    for (let d = 2.0; d <= 4.0; d += 0.01) {
      const r = levelForDensity(0, d);
      const vis = r.index === 0 ? 1 : r.index === 1 ? r.finerWeight : 0;
      if (prev >= 0) expect(Math.abs(vis - prev)).toBeLessThan(0.05);
      prev = vis;
    }
    expect(FULL_SPACING_PX).toBeGreaterThan(MIN_SPACING_PX);
  });
});

describe('line coverage', () => {
  it.each([
    [0, 10, 1, 0],
    [5, 10, 1, 5],
    [12, 10, 1, 2],
    [-3, 10, 2, 1.5],
    [995, 10, 0.5, 10],
  ])('distance of h=%p to the %p m levels at %p m/px is %p px', (h, iv, d, px) => {
    expect(distanceToLevelPx(h, iv, d)).toBeCloseTo(px, 9);
  });
  it('coverage is 1 on the line, 0 beyond half-width + 0.5, linear between', () => {
    expect(lineCoverage(0, 1.1)).toBe(1);
    expect(lineCoverage(1.05, 1.1)).toBe(0);
    expect(lineCoverage(0.55, 1.1)).toBeCloseTo(0.5, 9);
  });
  it('a constant screen width: coverage depends on px distance, not metres', () => {
    // Same 0.4 px offset, two very different slopes.
    expect(lineCoverage(distanceToLevelPx(100.4, 10, 1), MINOR_WIDTH_PX)).toBeCloseTo(
      lineCoverage(distanceToLevelPx(104, 10, 10), MINOR_WIDTH_PX),
      9,
    );
  });
  it.each([
    [0, 10, 50, true],
    [50, 10, 50, true],
    [40, 10, 50, false],
    [-50, 10, 50, true],
    [100, 25, 100, true],
    [75, 25, 100, false],
  ])('h %p on [%p, %p]: index line %p', (h, mi, ma, yes) => {
    expect(isMajorLevel(h, mi, ma)).toBe(yes);
  });
});

describe('contourAt', () => {
  it('an index line is drawn wide, not also as a minor', () => {
    const s = contourAt(1000, 1, 14);
    expect(s.major).toBe(1);
    expect(s.minor).toBe(0);
  });
  it('a minor level away from an index', () => {
    const s = contourAt(1010, 1, 14);
    expect(s.minor).toBe(1);
    expect(s.major).toBe(0);
  });
  it('midway between levels nothing is drawn', () => {
    expect(contourAt(1005, 1, 14)).toEqual({ minor: 0, major: 0 });
  });
  it('index lines are wider than minors', () => {
    const off = 0.9; // px from the line
    const minor = contourAt(1010 + off, 1, 14).minor;
    const major = contourAt(1000 + off, 1, 14).major;
    expect(major).toBeGreaterThan(minor);
    expect(MAJOR_WIDTH_PX).toBeGreaterThan(MINOR_WIDTH_PX);
  });
  it('coverage stays in [0, 1] over a sweep', () => {
    for (let h = 0; h < 600; h += 0.37) {
      for (const d of [0.3, 1, 4, 20]) {
        const s = contourAt(h, d, 12);
        expect(s.minor).toBeGreaterThanOrEqual(0);
        expect(s.minor).toBeLessThanOrEqual(1);
        expect(s.major).toBeGreaterThanOrEqual(0);
        expect(s.major).toBeLessThanOrEqual(1);
      }
    }
  });
});
