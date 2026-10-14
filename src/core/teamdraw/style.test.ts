import { MEMBER_COLORS } from '@core/teamui/colors';

import { defaultPrefs, DEFAULT_FADE_MS, FADE_CHOICES_MS, normalisePrefs, penStyle } from './style';

/** Hue in degrees of a #RRGGBB colour, and its saturation (HSV). */
function hueSat(hex: string): [number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return [0, 0];
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, d / max];
}

describe('drawing style prefs', () => {
  it('defaults: my own colour, width 2, solid, filled medium head, 30 s', () => {
    expect(defaultPrefs(3)).toEqual({
      colour: 3,
      width: 2,
      dashed: false,
      head: 'fill',
      headSize: 2,
      fadeMs: 30_000,
    });
    expect(DEFAULT_FADE_MS).toBe(30_000);
    // A join index past the palette wraps, like member colours do.
    expect(defaultPrefs(10).colour).toBe(2);
    expect(defaultPrefs(-1).colour).toBe(7);
    expect(defaultPrefs(Number.NaN).colour).toBe(0);
  });

  it('offers the seven fade choices, Never included', () => {
    expect(FADE_CHOICES_MS).toEqual([10_000, 30_000, 60_000, 300_000, 1_800_000, 14_400_000, null]);
  });

  it('normalises anything stored, field by field', () => {
    expect(normalisePrefs(undefined, 1)).toEqual(defaultPrefs(1));
    expect(normalisePrefs('junk', 1)).toEqual(defaultPrefs(1));
    expect(
      normalisePrefs(
        { colour: 5, width: 3, dashed: true, head: 'both', headSize: 1, fadeMs: null },
        1,
      ),
    ).toEqual({ colour: 5, width: 3, dashed: true, head: 'both', headSize: 1, fadeMs: null });
    expect(
      normalisePrefs(
        { colour: 8, width: 0, dashed: 'yes', head: 'barbed', headSize: 4, fadeMs: 12_345 },
        1,
      ),
    ).toEqual(defaultPrefs(1));
    expect(normalisePrefs({ colour: -1 }, 1).colour).toBe(1);
    expect(normalisePrefs({ colour: '#FF0000' }, 1).colour).toBe(1);
  });

  it('no red: every choosable colour is a member hue, clear of the SOS red', () => {
    for (const hex of MEMBER_COLORS) {
      const [h, s] = hueSat(hex);
      const fromRed = Math.min(h, 360 - h);
      expect(fromRed > 15 || s < 0.3).toBe(true);
    }
    expect(hueSat('#808080')).toEqual([0, 0]);
  });

  it('carries the style onto the wire', () => {
    expect(penStyle(defaultPrefs(4))).toEqual({ c: 4, w: 2, d: false, ht: 'fill', hs: 2 });
  });
});
