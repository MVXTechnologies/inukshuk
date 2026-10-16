import {
  onMapCount,
  FADE_FLOOR,
  fadeStart,
  fadeState,
  fadeWindowMs,
  formatLeft,
  FRAME_MS,
  isFading,
  OPACITY_STEP,
  nextChangeAt,
  opacityAt,
  quantLeftS,
  quantOpacity,
  tickDelayMs,
  type Life,
} from './fade';

const S = 1000;
const MIN = 60 * S;
const life = (ms: number | null, created = 0): Life => ({
  created,
  expires: ms === null ? null : created + ms,
});

/** Run the fade timer the way the UI does: sleep until the next change (≥ one frame), count frames. */
function frames(
  shapes: Life[],
  from: number,
): { ticks: number; changes: number; states: string[] } {
  let now = from;
  let ticks = 0;
  let changes = 0;
  const key = (t: number) => shapes.map((s) => JSON.stringify(fadeState(s, t))).join('|');
  let last = key(now);
  const states = [last];
  for (;;) {
    const delay = tickDelayMs(nextChangeAt(shapes, now), now);
    if (delay === null) break;
    now += delay;
    ticks++;
    const k = key(now);
    if (k !== last) {
      changes++;
      states.push(k);
    }
    last = k;
  }
  return { ticks, changes, states };
}

describe('fade curve', () => {
  it('the window is the last 25 % of the life, within [5 s, 15 min]', () => {
    expect(fadeWindowMs(10 * S)).toBe(5 * S);
    expect(fadeWindowMs(30 * S)).toBe(7.5 * S);
    expect(fadeWindowMs(5 * MIN)).toBe(75 * S);
    expect(fadeWindowMs(4 * 60 * MIN)).toBe(15 * MIN);
    expect(fadeStart(life(5 * MIN))).toBe(5 * MIN - 75 * S);
    expect(fadeStart(life(null))).toBeNull();
  });

  it('full, then a smoothstep down to 30 %, then gone; Never never fades', () => {
    const l = life(5 * MIN);
    expect(opacityAt(l, 0)).toBe(1);
    expect(opacityAt(l, fadeStart(l)!)).toBe(1);
    const mid = fadeStart(l)! + 37.5 * S;
    expect(opacityAt(l, mid)).toBeCloseTo(1 - 0.7 * 0.5, 9);
    expect(opacityAt(l, 5 * MIN - 1)).toBeGreaterThan(FADE_FLOOR);
    expect(opacityAt(l, 5 * MIN - 1)).toBeLessThan(0.31);
    expect(opacityAt(l, 5 * MIN)).toBe(0);
    expect(opacityAt(life(null), 1e12)).toBe(1);
    // Monotone.
    let prev = 1;
    for (let t = 0; t < 5 * MIN; t += 997) {
      const o = opacityAt(l, t);
      expect(o).toBeLessThanOrEqual(prev);
      prev = o;
    }
  });

  it('quantises opacity to 0.01, never below the floor while visible', () => {
    expect(OPACITY_STEP).toBe(0.01);
    expect(quantOpacity(1)).toBe(1);
    expect(quantOpacity(0.512)).toBeCloseTo(0.51, 9);
    expect(quantOpacity(0.5149)).toBeCloseTo(0.51, 9);
    expect(quantOpacity(0.3001)).toBeCloseTo(0.3, 9);
    expect(quantOpacity(0.29)).toBe(0.3);
    expect(quantOpacity(0)).toBe(0);
  });

  it('time left: 1 s steps under 10 s, 5 s under a minute, minutes above', () => {
    expect(quantLeftS(8_200)).toBe(9);
    expect(quantLeftS(9_000)).toBe(9);
    expect(quantLeftS(9_001)).toBe(10);
    expect(quantLeftS(10_001)).toBe(15);
    expect(quantLeftS(14_200)).toBe(15);
    expect(quantLeftS(59_000)).toBe(60);
    expect(quantLeftS(61_000)).toBe(120);
    expect(quantLeftS(899_000)).toBe(900);
    expect(formatLeft(15)).toBe('15 s');
    expect(formatLeft(120)).toBe('2 min');
  });

  it('shows the clock only inside the window', () => {
    const l = life(30 * MIN);
    expect(fadeState(l, 0)).toEqual({ visible: true, opacity: 1, left: null });
    expect(fadeState(l, 28 * MIN)).toMatchObject({ visible: true, left: 120 });
    expect(fadeState(l, 30 * MIN)).toEqual({ visible: false, opacity: 0, left: null });
    expect(fadeState(life(null), 1e12)).toEqual({ visible: true, opacity: 1, left: null });
  });
});

describe('nextChangeAt', () => {
  it('sleeps until the window opens; nothing at all for Never or expired shapes', () => {
    const l = life(4 * 60 * MIN);
    expect(nextChangeAt([l], 0)).toBe(fadeStart(l)! + 1);
    expect(nextChangeAt([life(null)], 0)).toBeNull();
    expect(nextChangeAt([life(10 * S)], 10 * S)).toBeNull();
    expect(nextChangeAt([], 0)).toBeNull();
    expect(tickDelayMs(null, 0)).toBeNull();
    expect(tickDelayMs(10, 0)).toBe(FRAME_MS);
    expect(tickDelayMs(5000, 0)).toBe(5000);
  });

  it('never misses a change: every quantised step is seen, in order, up to the end', () => {
    for (const ms of [10 * S, 30 * S, MIN, 5 * MIN, 30 * MIN]) {
      const l = life(ms, 1_000_000);
      // Ground truth: the distinct states, sampled every 1 ms through the window
      // (a step of the badge clock and one of opacity can fall 1 ms apart).
      const truth: string[] = [JSON.stringify(fadeState(l, 1_000_000))];
      for (let t = fadeStart(l)!; t <= 1_000_000 + ms; t += 1) {
        const k = JSON.stringify(fadeState(l, t));
        if (truth[truth.length - 1] !== k) truth.push(k);
      }
      const seen = frames([l], 1_000_000).states;
      // Every state the timer shows is a true state, in order, ending gone.
      let at = 0;
      for (const k of seen) {
        at = truth.indexOf(k, at);
        expect(at).toBeGreaterThanOrEqual(0);
      }
      expect(seen[seen.length - 1]).toBe(
        JSON.stringify({ visible: false, opacity: 0, left: null }),
      );
      // Only the one-frame floor merges states (two changes closer than 33 ms
      // apart, such as a clock step landing just before an opacity step).
      expect(truth.length - seen.length).toBeLessThanOrEqual(12);
    }
  });

  it('budget: a 5 min shape costs about 90 source rebuilds over its whole life (counted)', () => {
    const { changes, ticks } = frames([life(5 * MIN)], 0);
    // 70 opacity steps of 0.01 (1 → 0.3) and the badge clock: all inside the
    // 75 s window, none before it.
    expect(changes).toBeLessThanOrEqual(95); // measured: 92
    expect(ticks).toBeLessThanOrEqual(changes + 2);
    // A 4 h shape: no timer for 3 h 45 min, then about the same.
    const long = frames([life(4 * 60 * MIN)], 0);
    expect(long.ticks).toBeLessThanOrEqual(110); // measured: 105
  });

  it('takes the earliest change over many shapes', () => {
    const a = life(10 * MIN);
    const b = life(10 * S, 4 * MIN);
    expect(nextChangeAt([a, b], 4 * MIN)).toBe(fadeStart(b)! + 1);
    expect(nextChangeAt([b, a], 4 * MIN)).toBe(fadeStart(b)! + 1);
  });
});

describe('a smooth fade (#756)', () => {
  /** What the map draws at `t` when the timer last woke at `drawnAt`. */
  const drawn = (l: Life, drawnAt: number) => fadeState(l, drawnAt).opacity;

  it('opacity is a continuous function of time: sub-second samples never jump', () => {
    for (const ms of [10 * S, 30 * S, MIN, 5 * MIN]) {
      const l = life(ms);
      const end = l.expires!;
      let prev = opacityAt(l, 0);
      // Every 100 ms through the whole life, up to the last instant before expiry.
      for (let t = 100; t < end; t += 100) {
        const o = opacityAt(l, t);
        // The steepest point of a 5 s window moves 0.7 × 1.5 / 5 s = 0.21 per second.
        expect(prev - o).toBeLessThanOrEqual(0.021 + 1e-9);
        expect(o).toBeLessThanOrEqual(prev);
        prev = o;
      }
      // And at 10 ms steps the change is ten times smaller (no hidden step).
      for (let t = fadeStart(l)!; t + 10 < end; t += 10) {
        expect(opacityAt(l, t) - opacityAt(l, t + 10)).toBeLessThanOrEqual(0.0021 + 1e-9);
      }
    }
  });

  it('what is drawn tracks the curve within one 0.01 step at every 10 ms instant', () => {
    for (const ms of [10 * S, 30 * S, 5 * MIN]) {
      const l = life(ms);
      let wake = 0;
      let next = 0;
      for (let t = 0; t < l.expires!; t += 10) {
        // The UI's timer: wake at the scheduled time, draw the state then.
        while (next <= t) {
          wake = next;
          const delay = tickDelayMs(nextChangeAt([l], wake), wake);
          next = delay === null ? Infinity : wake + delay;
        }
        // Rounding to 0.01 is ±0.005; one more frame of the steepest slope stays under 0.01.
        expect(Math.abs(drawn(l, wake) - opacityAt(l, t))).toBeLessThanOrEqual(OPACITY_STEP);
      }
    }
  });

  it('each redraw moves the opacity by at most one step, and the timer wakes at most per frame', () => {
    const l = life(30 * S);
    let now = fadeStart(l)!;
    let prev = drawn(l, now);
    for (;;) {
      const delay = tickDelayMs(nextChangeAt([l], now), now);
      if (delay === null) break;
      expect(delay).toBeGreaterThanOrEqual(FRAME_MS);
      now += delay;
      const o = drawn(l, now);
      if (o > 0) expect(prev - o).toBeLessThanOrEqual(OPACITY_STEP + 1e-9);
      prev = o;
    }
    expect(prev).toBe(0);
  });

  it('isFading: only inside the window, never for Never or after expiry', () => {
    const l = life(30 * S);
    expect(isFading(l, 0)).toBe(false);
    expect(isFading(l, fadeStart(l)!)).toBe(false);
    expect(isFading(l, fadeStart(l)! + 1)).toBe(true);
    expect(isFading(l, 30 * S - 1)).toBe(true);
    expect(isFading(l, 30 * S)).toBe(false);
    expect(isFading(life(null), 1e12)).toBe(false);
  });
});

describe('onMapCount (Manage team › Drawings)', () => {
  it('counts what is on the map now, and says when that changes', () => {
    const shapes = [{ expires: null }, { expires: 1_000 }, { expires: 3_000 }, { expires: 500 }];
    expect(onMapCount(shapes, 600)).toEqual({ count: 3, changesAt: 1_000 });
    expect(onMapCount(shapes, 1_000)).toEqual({ count: 2, changesAt: 3_000 });
    expect(onMapCount(shapes, 5_000)).toEqual({ count: 1, changesAt: null });
    expect(onMapCount([], 0)).toEqual({ count: 0, changesAt: null });
  });
});
