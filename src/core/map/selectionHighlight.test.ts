import {
  HIGHLIGHT_CASING_W,
  HIGHLIGHT_GLOW_W,
  HIGHLIGHT_LINE_W,
  selectionHighlight,
} from './selectionHighlight';

describe('selectionHighlight (#747 option 1)', () => {
  it('layers glow ⊃ casing ⊃ line, as in the mockup (5 dp line on a 9 dp casing)', () => {
    expect(HIGHLIGHT_LINE_W).toBe(5);
    expect(HIGHLIGHT_CASING_W).toBe(9);
    expect(HIGHLIGHT_GLOW_W).toBeGreaterThan(HIGHLIGHT_CASING_W);
    for (const ground of ['paper', 'night', 'imagery'] as const) {
      const s = selectionHighlight(ground);
      expect(s.line.width).toBeLessThan(s.casing.width);
      expect(s.casing.width).toBeLessThan(s.glow.width);
      expect(s.glow.opacity).toBeGreaterThan(0);
      expect(s.glow.opacity).toBeLessThan(1);
    }
  });

  it('a white casing on the paper map, a cool off-white on dark grounds', () => {
    expect(selectionHighlight('paper').casing.color).toBe('#FFFFFF');
    expect(selectionHighlight('night').casing.color).toBe('#E9FBFF');
    expect(selectionHighlight('imagery').casing.color).toBe('#E9FBFF');
  });

  it('the glow is cyan on every ground', () => {
    for (const ground of ['paper', 'night', 'imagery'] as const) {
      const hex = selectionHighlight(ground).glow.color;
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      expect(r).toBeLessThan(40);
      expect(g).toBeGreaterThan(150);
      expect(b).toBeGreaterThan(200);
    }
  });
});
