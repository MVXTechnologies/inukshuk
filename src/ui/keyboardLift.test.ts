import { keyboardLift } from './keyboardLift';

describe('keyboardLift', () => {
  it('rises by how far the keyboard covers the bottom edge, plus a margin', () => {
    expect(keyboardLift(800, 500)).toBe(308);
    expect(keyboardLift(800, 500, 0)).toBe(300);
  });

  it('stays put when the keyboard is down or already below', () => {
    expect(keyboardLift(800, null)).toBe(0);
    expect(keyboardLift(480, 500)).toBe(0);
  });
});
