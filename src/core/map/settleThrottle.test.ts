import { createSettleThrottle } from './settleThrottle';

describe('createSettleThrottle', () => {
  it('passes events outside a stream straight through', () => {
    const th = createSettleThrottle(400);
    for (let t = 0; t < 100; t += 10) expect(th.push(t, false)).toEqual({ kind: 'run' });
    expect(th.holding()).toBe(false);
  });

  it('thins a 60 Hz stream to one per interval, the first at once, and keeps the last', () => {
    const th = createSettleThrottle(400);
    let runs = 0;
    let lastRun = -Infinity;
    let deferredFor: number | null = null;
    for (let k = 0; k < 120; k++) {
      const t = (k * 1000) / 60; // 2 s of frames
      if (deferredFor !== null && t >= deferredFor && th.flush(t)) {
        runs++;
        lastRun = t;
        deferredFor = null;
      }
      const d = th.push(t, true);
      if (d.kind === 'run') {
        runs++;
        lastRun = t;
      } else if (deferredFor === null) deferredFor = t + d.inMs;
    }
    // 2 s at ≤ 2.5 a second: 5–6 handled out of 120.
    expect(runs).toBeGreaterThanOrEqual(5);
    expect(runs).toBeLessThanOrEqual(6);
    // The stream's last event is still held, and is delivered when due.
    expect(th.holding()).toBe(true);
    expect(th.flush(lastRun + 399)).toBe(false); // too soon after the last run
    expect(th.flush(lastRun + 400)).toBe(true);
    expect(th.holding()).toBe(false);
    expect(th.flush(5000)).toBe(false); // nothing left
  });

  it('a gesture during a stream runs at once and drops the held one (the newer view wins)', () => {
    const th = createSettleThrottle(400);
    th.push(0, true);
    expect(th.push(100, true)).toEqual({ kind: 'defer', inMs: 300 });
    expect(th.holding()).toBe(true);
    expect(th.push(150, false)).toEqual({ kind: 'run' });
    expect(th.holding()).toBe(false);
    expect(th.flush(1000)).toBe(false);
  });

  it('rejects a non-positive interval', () => {
    expect(() => createSettleThrottle(0)).toThrow();
  });
});
