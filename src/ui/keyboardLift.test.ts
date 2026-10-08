import { keyboardLift } from './keyboardLift';

describe('keyboardLift', () => {
  it('rises by how far the keyboard covers the bottom edge, plus a margin', () => {
    // The CI emulator's pin composer (run 37805821997), in screen dp: bottom at
    // 697.14 + 156.19, keyboard top at 914.29 - 336.38.
    expect(keyboardLift(697.14 + 156.19, 914.29 - 336.38)).toBeCloseTo(283.42, 2);
    expect(keyboardLift(853, 578, 0)).toBe(275);
  });

  it('stays put when the keyboard is already below the view', () => {
    expect(keyboardLift(480, 578)).toBe(0);
  });
});
