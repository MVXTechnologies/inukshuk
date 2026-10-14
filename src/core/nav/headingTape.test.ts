import { at } from './__fixtures__/paths';
import {
  chooseTapeSource,
  COG_MIN_SPEED_MPS,
  createCourseTracker,
  tapeLabelClear,
  tapeLabelHalfWidth,
  tapeMarker,
  tapeTicks,
  turnHint,
} from './headingTape';

describe('tapeTicks', () => {
  it('spans ±60° every 5° with labels on the 30° majors', () => {
    const ticks = tapeTicks(0);
    expect(ticks).toHaveLength(25);
    expect(ticks[0]).toMatchObject({ deg: 300, offset: -1, major: true, label: '300' });
    expect(ticks[12]).toMatchObject({ deg: 0, offset: 0, major: true, label: 'N' });
    expect(ticks[24]).toMatchObject({ deg: 60, offset: 1, label: '60' });
    expect(ticks.find((t) => t.deg === 10)).toMatchObject({ medium: true, label: null });
    expect(ticks.find((t) => t.deg === 15)).toMatchObject({ medium: false, major: false });
  });

  it('scrolls with the heading and wraps 0/360', () => {
    const ticks = tapeTicks(352);
    expect(ticks[0]!.deg).toBe(295);
    expect(ticks.map((t) => t.label).filter(Boolean)).toEqual(['300', '330', 'N', '30']);
    for (const t of ticks) expect(Math.abs(t.offset)).toBeLessThanOrEqual(1);
    // 0° sits 8° right of the index.
    expect(ticks.find((t) => t.deg === 0)!.offset).toBeCloseTo(8 / 60, 6);
  });

  it('labels every cardinal', () => {
    const labels = [0, 90, 180, 270].map((h) => tapeTicks(h).find((t) => t.offset === 0)!.label);
    expect(labels).toEqual(['N', 'E', 'S', 'W']);
  });
});

describe('tapeMarker', () => {
  it('places a bearing inside the window', () => {
    expect(tapeMarker(38, 42)).toEqual({ kind: 'on', offset: 4 / 60, deltaDeg: 4 });
    expect(tapeMarker(10, 350)).toMatchObject({ kind: 'on', deltaDeg: -20 });
  });

  it('pins a bearing beyond ±60° to the edge to turn towards (the 340 → 042 mockup)', () => {
    expect(tapeMarker(340, 42)).toEqual({ kind: 'edge', side: 'right', deltaDeg: 62 });
    expect(tapeMarker(90, 0)).toEqual({ kind: 'edge', side: 'left', deltaDeg: -90 });
  });
});

describe('tapeLabelClear', () => {
  it('keeps a label clear of nothing', () => {
    expect(tapeLabelClear(50, '60', [])).toBe(true);
  });

  it('hides a label under a marker, and shows it once clear', () => {
    const flag: [number, number] = [44, 56];
    expect(tapeLabelClear(50, '60', [flag])).toBe(false);
    // Just touching the edge (label half width + 2 px air) is still hidden…
    const half = tapeLabelHalfWidth('60') + 2;
    expect(tapeLabelClear(56 + half - 0.5, '60', [flag])).toBe(false);
    // …and clear beyond it, on either side.
    expect(tapeLabelClear(56 + half, '60', [flag])).toBe(true);
    expect(tapeLabelClear(44 - half, '60', [flag])).toBe(true);
  });

  it('checks every span (edge arrow, trail bar, COG)', () => {
    const spans: [number, number][] = [
      [0, 36],
      [100, 118],
      [190, 200],
    ];
    expect(tapeLabelClear(20, 'N', spans)).toBe(false);
    expect(tapeLabelClear(110, '330', spans)).toBe(false);
    expect(tapeLabelClear(195, 'E', spans)).toBe(false);
    expect(tapeLabelClear(70, '300', spans)).toBe(true);
  });

  it('gives three-digit labels more room than a cardinal', () => {
    expect(tapeLabelHalfWidth('330')).toBeGreaterThan(tapeLabelHalfWidth('N'));
  });
});

describe('turnHint', () => {
  it('says which way and how far', () => {
    expect(turnHint(62)).toBe('Right 62°');
    expect(turnHint(-11.6)).toBe('Left 12°');
    expect(turnHint(0)).toBe('Right 0°');
  });
});

describe('createCourseTracker', () => {
  it('reads speed and course once the fixes are far enough apart', () => {
    const c = createCourseTracker();
    expect(c.push(at(0, 0), 0)).toEqual({ speedMps: 0, courseDeg: null });
    const s = c.push(at(0, 5), 4000);
    expect(s.speedMps).toBeCloseTo(1.25, 2);
    expect(s.courseDeg).toBeCloseTo(0, 0);
  });

  it('does not spin the course on standing-still jitter, and the speed decays', () => {
    const c = createCourseTracker();
    c.push(at(0, 0), 0);
    c.push(at(10, 0), 5000); // walking east at 2 m/s
    const jitter = [
      [11, 1],
      [9, -1],
      [11, 0.5],
    ] as const;
    let last = c.push(at(10, 0), 6000);
    jitter.forEach(([x, y], i) => {
      last = c.push(at(x, y), 7000 + i * 1000);
    });
    expect(last.courseDeg).toBeCloseTo(90, 0);
    expect(last.speedMps).toBeLessThan(COG_MIN_SPEED_MPS);
  });

  it('restarts after a long silence or a clock going backwards', () => {
    const c = createCourseTracker();
    c.push(at(0, 0), 0);
    c.push(at(0, 10), 5000);
    expect(c.push(at(0, 20), 60_000)).toEqual({ speedMps: 0, courseDeg: null });
    expect(c.push(at(0, 30), 1000)).toEqual({ speedMps: 0, courseDeg: null });
  });
});

describe('chooseTapeSource', () => {
  const moving = { speedMps: 1.2, courseDeg: 95 };
  const still = { speedMps: 0.2, courseDeg: 95 };

  it('prefers the compass whenever it has reported', () => {
    expect(chooseTapeSource(370, moving)).toEqual({ kind: 'compass', headingDeg: 10 });
  });

  it('falls back to the course over ground above 0.5 m/s', () => {
    expect(chooseTapeSource(null, moving)).toEqual({ kind: 'cog', headingDeg: 95 });
  });

  it('hides (null) when there is neither', () => {
    expect(chooseTapeSource(null, still)).toBeNull();
    expect(chooseTapeSource(null, { speedMps: 3, courseDeg: null })).toBeNull();
    expect(chooseTapeSource(NaN, still)).toBeNull();
  });
});
