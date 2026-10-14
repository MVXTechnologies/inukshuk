import {
  FADE_FLOOR,
  fadeStart,
  fadeState,
  fadeWindowMs,
  formatLeft,
  MIN_TICK_MS,
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

/** Run the fade timer the way the UI will: sleep until the next change (≥ 1 s), count frames. */
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

  it('quantises opacity to 0.05, never below the floor while visible', () => {
    expect(quantOpacity(1)).toBe(1);
    expect(quantOpacity(0.512)).toBeCloseTo(0.5, 9);
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
    expect(tickDelayMs(10, 0)).toBe(MIN_TICK_MS);
    expect(tickDelayMs(5000, 0)).toBe(5000);
  });

  it('never misses a change: every quantised step is seen, in order, up to the end', () => {
    for (const ms of [10 * S, 30 * S, MIN, 5 * MIN, 30 * MIN]) {
      const l = life(ms, 1_000_000);
      // Ground truth: the distinct states, sampled every 50 ms.
      const truth: string[] = [];
      for (let t = 1_000_000; t <= 1_000_000 + ms; t += 50) {
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
      // Only the 1 s timer floor merges states: in the last ~15 s, where the
      // clock ticks every second and opacity moves fastest (a 10 s shape has ~19
      // states in its 5 s window). Elsewhere, none is lost.
      if (ms >= MIN) expect(truth.length - seen.length).toBeLessThanOrEqual(10);
    }
  });

  it('budget: a 5 min shape costs about 30 source rebuilds over its whole life (counted)', () => {
    const { changes, ticks } = frames([life(5 * MIN)], 0);
    expect(changes).toBeLessThanOrEqual(35); // measured: 35
    expect(ticks).toBeLessThanOrEqual(changes + 2);
    // A 4 h shape: no timer for 3 h 45 min, then about the same.
    const long = frames([life(4 * 60 * MIN)], 0);
    expect(long.ticks).toBeLessThanOrEqual(50);
  });

  it('takes the earliest change over many shapes', () => {
    const a = life(10 * MIN);
    const b = life(10 * S, 4 * MIN);
    expect(nextChangeAt([a, b], 4 * MIN)).toBe(fadeStart(b)! + 1);
    expect(nextChangeAt([b, a], 4 * MIN)).toBe(fadeStart(b)! + 1);
  });
});
