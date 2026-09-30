import {
  HEAT_CROSSFADE,
  HEAT_GLOW_RADIUS_STOPS,
  HEAT_LINE_RAMP_DARK,
  HEAT_LINE_RAMP_LIGHT,
  HEAT_LINE_WIDTH_STOPS,
  heatGlowColorStops,
  heatGlowOpacity,
  heatGlowWeight,
  heatLineOpacity,
  heatLineWidthFactor,
  heatTapRadiusPx,
  interpolateStops,
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
const LIGHT_GROUND = '#EEEAE0';
const DARK_GROUND = '#1E2024';

describe('heat line ramps', () => {
  it('step by pass count', () => {
    expect(rampColor(HEAT_LINE_RAMP_LIGHT, 1)).toBe(HEAT_LINE_RAMP_LIGHT[0]?.[1]);
    expect(rampColor(HEAT_LINE_RAMP_LIGHT, 3)).toBe(HEAT_LINE_RAMP_LIGHT[1]?.[1]);
    expect(rampColor(HEAT_LINE_RAMP_LIGHT, 1000)).toBe(HEAT_LINE_RAMP_LIGHT.at(-1)?.[1]);
    expect(rampColor([], 3)).toBe('#000000');
  });

  it('keep a single pass clearly visible on both basemap tones', () => {
    expect(contrast(rampColor(HEAT_LINE_RAMP_LIGHT, 1), LIGHT_GROUND)).toBeGreaterThanOrEqual(2);
    expect(contrast(rampColor(HEAT_LINE_RAMP_DARK, 1), DARK_GROUND)).toBeGreaterThanOrEqual(3);
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

  it('widens lines with passes, capped', () => {
    expect(heatLineWidthFactor(1)).toBe(1);
    expect(heatLineWidthFactor(4)).toBeGreaterThan(heatLineWidthFactor(2));
    expect(heatLineWidthFactor(1e6)).toBeCloseTo(1.6);
    expect(heatLineWidthFactor(0)).toBe(1);
  });

  it('reaches as far as the glow while it is drawn, then defers to the trail tolerance', () => {
    expect(heatTapRadiusPx(10)).toBe(interpolateStops(HEAT_GLOW_RADIUS_STOPS, 10));
    expect(heatTapRadiusPx(HEAT_CROSSFADE[1] + 1)).toBe(0);
  });
});

describe('glow', () => {
  it('weights more passes more, log-scaled', () => {
    expect(heatGlowWeight(1)).toBe(0.5);
    expect(heatGlowWeight(16)).toBe(1.5);
    expect(heatGlowWeight(0)).toBe(0.5);
  });

  it('shows a lone pass (non-zero alpha right above zero density)', () => {
    const stops = heatGlowColorStops(HEAT_LINE_RAMP_LIGHT);
    expect(stops[0]?.[2]).toBe(0);
    expect(stops[1]?.[2]).toBeGreaterThanOrEqual(0.4);
    const alphas = stops.map(([, , a]) => a);
    expect([...alphas].sort((a, b) => a - b)).toEqual(alphas);
  });

  it('formats rgba strings', () => {
    expect(rgba('#FF8000', 0.5)).toBe('rgba(255,128,0,0.5)');
  });
});
