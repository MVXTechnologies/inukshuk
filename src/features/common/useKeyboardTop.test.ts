import { androidKeyboardTop, keyboardLift } from './useKeyboardTop';

describe('keyboardLift', () => {
  it('rises by how far the keyboard covers the bottom edge, plus a margin', () => {
    expect(keyboardLift(800, 500)).toBe(308);
    expect(keyboardLift(800, 500, 0)).toBe(300);
  });

  it('stays put when the keyboard is down or already below (a resized window)', () => {
    expect(keyboardLift(800, null)).toBe(0);
    expect(keyboardLift(480, 500)).toBe(0);
  });
});

describe('androidKeyboardTop', () => {
  it('uses the height on an edge-to-edge window, where screenY stays at the bottom', () => {
    // 914 dp screen, 24 dp navigation bar, a 300 dp keyboard above it.
    expect(androidKeyboardTop(914, 300, 914, 24)).toBe(590);
  });

  it('keeps screenY when the window was resized for the keyboard', () => {
    expect(androidKeyboardTop(590, 300, 914, 24)).toBe(590);
  });
});
