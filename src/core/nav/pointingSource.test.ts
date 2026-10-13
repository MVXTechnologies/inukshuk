import { COG_MIN_SPEED_MPS } from './headingTape';
import { choosePointingBearing, createHeadingGate } from './pointingSource';

const still = { speedMps: 0, courseDeg: null };
const moving = { speedMps: 1.4, courseDeg: 200 };
const slow = { speedMps: COG_MIN_SPEED_MPS, courseDeg: 200 };

describe('choosePointingBearing', () => {
  it('heading: the compass while there is one', () => {
    expect(choosePointingBearing('heading', 0, 361, moving)).toEqual({
      bearingDeg: 1,
      kind: 'compass',
    });
  });

  it('heading without a magnetometer: COG above 0.5 m/s, otherwise hidden', () => {
    expect(choosePointingBearing('heading', 0, null, moving)).toEqual({
      bearingDeg: 200,
      kind: 'cog',
    });
    expect(choosePointingBearing('heading', 0, null, slow)).toBeNull();
    expect(choosePointingBearing('heading', 0, null, still)).toBeNull();
  });

  it('course: COG only, whatever the compass says', () => {
    expect(choosePointingBearing('course', 0, 90, moving)).toEqual({
      bearingDeg: 200,
      kind: 'cog',
    });
    expect(choosePointingBearing('course', 0, 90, slow)).toBeNull();
  });

  it('fixed: always, compass or not, moving or not', () => {
    expect(choosePointingBearing('fixed', 62, null, still)).toEqual({
      bearingDeg: 62,
      kind: 'fixed',
    });
    expect(choosePointingBearing('fixed', -10, 5, moving)).toEqual({
      bearingDeg: 350,
      kind: 'fixed',
    });
    expect(choosePointingBearing('fixed', NaN, 5, moving)).toBeNull();
  });
});

describe('createHeadingGate (4 Hz, 1° dead-band)', () => {
  it('emits the first sample, drops sub-degree steps, holds a too-early turn', () => {
    const g = createHeadingGate();
    expect(g.push(100, 0)).toEqual({ kind: 'emit', headingDeg: 100 });
    expect(g.push(100.9, 300)).toEqual({ kind: 'drop' });
    expect(g.push(105, 400)).toEqual({ kind: 'emit', headingDeg: 105 });
    expect(g.push(110, 500)).toEqual({ kind: 'wait', inMs: 150 });
    expect(g.flush(600)).toBeNull();
    expect(g.flush(650)).toBe(110);
    expect(g.flush(1000)).toBeNull(); // nothing held any more
  });

  it('forgets a held turn when the heading comes back within the dead-band', () => {
    const g = createHeadingGate();
    g.push(10, 0);
    expect(g.push(20, 100).kind).toBe('wait');
    expect(g.push(10.5, 150)).toEqual({ kind: 'drop' });
    expect(g.flush(300)).toBeNull();
  });

  it('wraps 359° → 0° as a sub-degree turn, not 359°', () => {
    const g = createHeadingGate();
    g.push(359.5, 0);
    expect(g.push(0.2, 1000)).toEqual({ kind: 'drop' });
  });

  it('a steady turn at sensor rate renders at most 4 times a second (measured)', () => {
    const g = createHeadingGate();
    let renders = 0;
    let deadline: number | null = null;
    // 20 Hz samples turning 3° each, for 5 s; a timer flushes the held one.
    for (let t = 0; t <= 5000; t += 50) {
      if (deadline !== null && t >= deadline) {
        if (g.flush(t) !== null) renders++;
        deadline = null;
      }
      const r = g.push((t / 50) * 3, t);
      if (r.kind === 'emit') renders++;
      else if (r.kind === 'wait' && deadline === null) deadline = t + r.inMs;
    }
    expect(renders).toBeLessThanOrEqual(21); // 4 Hz × 5 s + the first
    expect(renders).toBeGreaterThanOrEqual(19);
  });
});
