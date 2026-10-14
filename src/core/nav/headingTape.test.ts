import { at } from './__fixtures__/paths';
import {
  chooseTapeSource,
  COG_MIN_SPEED_MPS,
  createCourseTracker,
  tapeLabelClear,
  tapeLabelHalfWidth,
  tapeMarker,
  tapeStripPositions,
  tapeStripTicks,
  tapeStripTranslatePx,
  tapeStripX,
  TAPE_HALF_SPAN_DEG,
  TAPE_STRIP_MARGIN_DEG,
  turnHint,
} from './headingTape';

describe('the tape strip', () => {
  const PX = 1.5; // px per degree

  it('draws the whole scale once, every 5°, from −margin to 360 + margin, majors labelled', () => {
    const ticks = tapeStripTicks();
    expect(TAPE_STRIP_MARGIN_DEG).toBeGreaterThan(TAPE_HALF_SPAN_DEG);
    expect(ticks[0]).toMatchObject({ at: -75, deg: 285, major: false, label: null });
    expect(ticks.at(-1)).toMatchObject({ at: 435, deg: 75 });
    expect(ticks).toHaveLength((360 + 2 * 75) / 5 + 1);
    expect(ticks.find((t) => t.at === 0)).toMatchObject({ deg: 0, major: true, label: 'N' });
    expect(ticks.find((t) => t.at === 360)).toMatchObject({ deg: 0, label: 'N' });
    expect(ticks.find((t) => t.at === -30)).toMatchObject({ deg: 330, label: '330' });
    expect(ticks.find((t) => t.at === 10)).toMatchObject({ medium: true, label: null });
    expect(ticks.find((t) => t.at === 15)).toMatchObject({ medium: false, major: false });
    const cardinals = [0, 90, 180, 270].map((a) => ticks.find((t) => t.at === a)?.label);
    expect(cardinals).toEqual(['N', 'E', 'S', 'W']);
  });

  it('puts the heading under the centre index, at any heading and on any turn count', () => {
    const cx = 85;
    for (const h of [0, 42, 359.5, 361, -1, 720.25]) {
      const tx = tapeStripTranslatePx(h, cx, PX);
      // The strip position of the heading, moved by tx, lands on the centre.
      const at = ((h % 360) + 360) % 360;
      expect(tapeStripX(at, PX) + tx).toBeCloseTo(cx, 9);
    }
  });

  it('wraps invisibly: just either side of north the strip shows the same scale', () => {
    const cx = 85;
    // The screen x of each labelled tick, for heading h.
    const view = (h: number) =>
      tapeStripTicks()
        .map((t) => ({ label: t.label, x: tapeStripX(t.at, PX) + tapeStripTranslatePx(h, cx, PX) }))
        .filter((t) => t.label !== null && t.x >= 0 && t.x <= 2 * cx)
        .map((t) => `${t.label}@${t.x.toFixed(3)}`);
    // 359.9° and 360.1° (= 0.1°): the scale moves 0.2° (0.3 px), never a turn.
    const before = view(359.9);
    const after = view(360.1);
    expect(before.map((v) => v.split('@')[0])).toEqual(after.map((v) => v.split('@')[0]));
    for (const [i, v] of before.entries()) {
      const x0 = Number(v.split('@')[1]);
      const x1 = Number(after[i]?.split('@')[1]);
      expect(x1 - x0).toBeCloseTo(-0.2 * PX, 6);
    }
  });

  it('places a bearing at every copy on the strip, the one nearest the heading first', () => {
    expect(tapeStripPositions(350, 10)).toEqual([370, 10]);
    expect(tapeStripPositions(10, 350)).toEqual([-10, 350]);
    expect(tapeStripPositions(180, 90)).toEqual([90]);
    expect(tapeStripPositions(359, 359)).toEqual([359, -1]);
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
