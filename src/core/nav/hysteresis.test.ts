import {
  latchLow,
  OFF_TRAIL_OUT_M,
  ON_COURSE_IN_DEG,
  ON_COURSE_OUT_DEG,
  ON_TRAIL_IN_M,
} from './hysteresis';

describe('latchLow', () => {
  it('turns on at onAt and off only past offAt', () => {
    let on = false;
    const trace = [20, 12, 10, 14, 15, 15.1, 12, 9].map((v) => {
      on = latchLow(on, v, ON_COURSE_IN_DEG, ON_COURSE_OUT_DEG);
      return on;
    });
    expect(trace).toEqual([false, false, true, true, true, false, false, true]);
  });

  it('ignores a non-finite reading', () => {
    expect(latchLow(true, NaN, 10, 15)).toBe(true);
    expect(latchLow(false, Infinity, 10, 15)).toBe(false);
  });

  it('has the agreed thresholds', () => {
    expect([ON_COURSE_IN_DEG, ON_COURSE_OUT_DEG]).toEqual([10, 15]);
    expect([ON_TRAIL_IN_M, OFF_TRAIL_OUT_M]).toEqual([20, 30]);
  });
});
