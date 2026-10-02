import {
  HEAT_CROSSFADE,
  HEAT_GLOW_RADIUS_STOPS,
  HEAT_GROUND_DARK,
  HEAT_GROUND_LIGHT,
  HEAT_LINE_RAMP_DARK,
  HEAT_LINE_RAMP_LIGHT,
  HEAT_LINE_WIDTH_STOPS,
  HEAT_PASS_STRENGTH,
  HEAT_RAMP_DARK,
  HEAT_RAMP_LIGHT,
  heatGlowColorStops,
  heatGlowOpacity,
  heatGlowWeight,
  heatLineOpacity,
  heatLineWidthFactor,
  heatPassStrength,
  heatTapRadiusPx,
  interpolateStops,
  mixHex,
  rampColor,
  rgba,
} from './heatStyle';

/** WCAG relative luminance of #rrggbb. */
function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
const LIGHT_GROUND = HEAT_GROUND_LIGHT;
const DARK_GROUND = HEAT_GROUND_DARK;

describe('heat line ramps', () => {
  it('step by pass count', () => {
    expect(rampColor(HEAT_LINE_RAMP_LIGHT, 1)).toBe(HEAT_LINE_RAMP_LIGHT[0]?.[1]);
    expect(rampColor(HEAT_LINE_RAMP_LIGHT, 3)).toBe(HEAT_LINE_RAMP_LIGHT[1]?.[1]);
    expect(rampColor(HEAT_LINE_RAMP_LIGHT, 1000)).toBe(HEAT_LINE_RAMP_LIGHT.at(-1)?.[1]);
    expect(rampColor([], 3)).toBe('#000000');
  });

  // Owner, 2026-10: "a little bit too intense (we see clearly all the
  // tracks)". A lone run is a faint trace; only much-run streets read strong.
  it('keep a single pass faint but still there on both basemap tones', () => {
    const light = contrast(rampColor(HEAT_LINE_RAMP_LIGHT, 1), LIGHT_GROUND);
    const dark = contrast(rampColor(HEAT_LINE_RAMP_DARK, 1), DARK_GROUND);
    // 2.1.0 drew it at 2.06:1 on paper and 4.14:1 at night.
    expect(light).toBeGreaterThan(1.25);
    expect(light).toBeLessThan(1.6);
    expect(dark).toBeGreaterThan(1.4);
    expect(dark).toBeLessThan(2.2);
  });

  it('run full strength from 5–8 passes (the ramp colours of 2.1.0)', () => {
    for (const n of [8, 16, 64]) {
      expect(rampColor(HEAT_LINE_RAMP_LIGHT, n)).toBe(rampColor(HEAT_RAMP_LIGHT, n));
      expect(rampColor(HEAT_LINE_RAMP_DARK, n)).toBe(rampColor(HEAT_RAMP_DARK, n));
    }
    expect(contrast(rampColor(HEAT_LINE_RAMP_LIGHT, 8), LIGHT_GROUND)).toBeGreaterThan(4.5);
    expect(contrast(rampColor(HEAT_LINE_RAMP_DARK, 8), DARK_GROUND)).toBeGreaterThan(9);
  });

  it('separate a much-run street from a lone pass by far more than before', () => {
    // Contrast above the ground, hot (8 passes, z14 width) over lone pass.
    const ink = (ramp: typeof HEAT_LINE_RAMP_LIGHT, ground: string, n: number) =>
      (contrast(rampColor(ramp, n), ground) - 1) * heatLineWidthFactor(n);
    expect(
      ink(HEAT_LINE_RAMP_LIGHT, LIGHT_GROUND, 8) / ink(HEAT_LINE_RAMP_LIGHT, LIGHT_GROUND, 1),
    ).toBeGreaterThan(10); // 2.1.0: 4.7
    expect(
      ink(HEAT_LINE_RAMP_DARK, DARK_GROUND, 8) / ink(HEAT_LINE_RAMP_DARK, DARK_GROUND, 1),
    ).toBeGreaterThan(8); // 2.1.0: 4.0
  });

  it('run hotter with more passes (monotonic contrast against the ground)', () => {
    const light = HEAT_LINE_RAMP_LIGHT.map(([, c]) => contrast(c, LIGHT_GROUND));
    const dark = HEAT_LINE_RAMP_DARK.map(([, c]) => contrast(c, DARK_GROUND));
    for (let i = 1; i < light.length; i++) expect(light[i]).toBeGreaterThan(light[i - 1]!);
    for (let i = 1; i < dark.length; i++) expect(dark[i]).toBeGreaterThan(dark[i - 1]!);
  });
});

describe('zoom behaviour', () => {
  it('interpolates stops linearly and clamps', () => {
    expect(interpolateStops(HEAT_LINE_WIDTH_STOPS, 0)).toBe(HEAT_LINE_WIDTH_STOPS[0]?.[1]);
    expect(interpolateStops(HEAT_LINE_WIDTH_STOPS, 30)).toBe(HEAT_LINE_WIDTH_STOPS.at(-1)?.[1]);
    expect(
      interpolateStops(
        [
          [0, 0],
          [10, 10],
        ],
        2.5,
      ),
    ).toBe(2.5);
    expect(interpolateStops([], 5)).toBe(0);
  });

  it('crossfades glow into lines', () => {
    const [from, to] = HEAT_CROSSFADE;
    expect(heatGlowOpacity(from - 2)).toBeGreaterThan(0.5);
    expect(heatGlowOpacity(to)).toBe(0);
    expect(heatLineOpacity(to)).toBe(1);
    expect(heatLineOpacity(from)).toBeLessThan(1);
  });

  it('draws a lone pass thinner than 2.1.0 did (2.4 px at z14)', () => {
    expect(interpolateStops(HEAT_LINE_WIDTH_STOPS, 14)).toBeLessThanOrEqual(1.8);
    expect(interpolateStops(HEAT_LINE_WIDTH_STOPS, 12)).toBeGreaterThanOrEqual(1);
  });

  it('widens lines with passes, capped', () => {
    expect(heatLineWidthFactor(1)).toBe(1);
    expect(heatLineWidthFactor(4)).toBeGreaterThan(heatLineWidthFactor(2));
    expect(heatLineWidthFactor(1e6)).toBeCloseTo(1.8);
    expect(heatLineWidthFactor(0)).toBe(1);
  });

  it('reaches as far as the glow while it is drawn, then defers to the trail tolerance', () => {
    expect(heatTapRadiusPx(10)).toBe(interpolateStops(HEAT_GLOW_RADIUS_STOPS, 10));
    expect(heatTapRadiusPx(HEAT_CROSSFADE[1] + 1)).toBe(0);
  });
});

describe('glow', () => {
  it('weights more passes more, log-scaled', () => {
    expect(heatGlowWeight(1)).toBe(0.35);
    expect(heatGlowWeight(16)).toBe(1.35);
    expect(heatGlowWeight(0)).toBe(0.35);
  });

  it('shows a lone pass as a faint haze (low alpha right above zero density)', () => {
    const stops = heatGlowColorStops(HEAT_RAMP_LIGHT);
    expect(stops[0]?.[2]).toBe(0);
    expect(stops[1]?.[2]).toBeGreaterThan(0.15);
    expect(stops[1]?.[2]).toBeLessThanOrEqual(0.3);
    const alphas = stops.map(([, , a]) => a);
    expect([...alphas].sort((a, b) => a - b)).toEqual(alphas);
  });

  it('formats rgba strings', () => {
    expect(rgba('#FF8000', 0.5)).toBe('rgba(255,128,0,0.5)');
  });
});

describe('pass strength', () => {
  it('steps from faint to full, never down', () => {
    expect(heatPassStrength(1)).toBe(HEAT_PASS_STRENGTH[0]?.[1]);
    expect(heatPassStrength(0)).toBe(HEAT_PASS_STRENGTH[0]?.[1]);
    expect(heatPassStrength(3)).toBe(heatPassStrength(2));
    expect(heatPassStrength(1000)).toBe(1);
    const values = HEAT_PASS_STRENGTH.map(([, v]) => v);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
    expect(values[0]).toBeLessThan(0.5);
  });

  it('fades the line ramps toward their ground by that strength', () => {
    expect(rampColor(HEAT_LINE_RAMP_LIGHT, 1)).toBe(
      mixHex(rampColor(HEAT_RAMP_LIGHT, 1), HEAT_GROUND_LIGHT, heatPassStrength(1)),
    );
    expect(HEAT_LINE_RAMP_DARK.map(([n]) => n)).toEqual(HEAT_RAMP_DARK.map(([n]) => n));
  });

  it('mixes colours over a ground', () => {
    expect(mixHex('#FF0000', '#000000', 0.5)).toBe('#800000');
    expect(mixHex('#123456', '#ABCDEF', 1)).toBe('#123456');
    expect(mixHex('#123456', '#ABCDEF', 0)).toBe('#ABCDEF');
    expect(mixHex('#123456', '#ABCDEF', 7)).toBe('#123456');
  });
});
