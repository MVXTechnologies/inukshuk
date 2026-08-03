import { hotColor } from './color';

describe('hotColor', () => {
  it('returns a valid #rrggbb hex distinct from the input', () => {
    const out = hotColor('#aeccdf'); // the pastel-river blue
    expect(out).toMatch(/^#[0-9a-f]{6}$/);
    expect(out).not.toBe('#aeccdf');
  });

  it('is deterministic', () => {
    expect(hotColor('#e07a5f')).toBe(hotColor('#e07a5f'));
  });

  it('boosts saturation: a pastel becomes more chromatic (max-min channel spread grows)', () => {
    const spread = (hex: string) => {
      const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      return Math.max(...v) - Math.min(...v);
    };
    expect(spread(hotColor('#aeccdf'))).toBeGreaterThan(spread('#aeccdf'));
  });

  it('leaves pure grey usable (no NaN channels)', () => {
    expect(hotColor('#808080')).toMatch(/^#[0-9a-f]{6}$/);
  });
});
