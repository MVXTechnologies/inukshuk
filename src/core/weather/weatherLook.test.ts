import { WIND_DRAPE_OPACITY } from './windLook';
import {
  ROAD_LINE_W,
  WATER_LINE_W,
  WEATHER_DRAPE_OPACITY,
  WEATHER_REFERENCE_INK,
} from './weatherLook';

describe('WEATHER_DRAPE_OPACITY', () => {
  it('is the shipped shared default', () => {
    expect(WEATHER_DRAPE_OPACITY).toBe(0.62);
  });

  it('is heavier than the wind drape, which draws its own ink on top', () => {
    // The two constants now live side by side precisely so this relationship
    // is checkable instead of being a comment in two files.
    expect(WIND_DRAPE_OPACITY).toBeLessThan(WEATHER_DRAPE_OPACITY);
  });
});

describe('WEATHER_REFERENCE_INK', () => {
  it('has a light and a dark polarity with the same casing budget', () => {
    expect(WEATHER_REFERENCE_INK.light.casingAdd).toBe(WEATHER_REFERENCE_INK.dark.casingAdd);
    expect(WEATHER_REFERENCE_INK.light.casingAdd).toBeGreaterThan(0);
  });

  it('keeps casing and core in opposite polarity in both themes', () => {
    // The casing is what carries contrast over a full-spectrum drape: near
    // white behind dark ink in light theme, near black behind light ink in
    // dark theme. A same-polarity pair is the bug this pattern replaced.
    expect(WEATHER_REFERENCE_INK.light.casing).toContain('255, 255, 255');
    expect(WEATHER_REFERENCE_INK.dark.casing).toContain('6, 11, 16');
  });

  it('states every ink as rgba so alpha is never lost to a hex shorthand', () => {
    for (const theme of [WEATHER_REFERENCE_INK.light, WEATHER_REFERENCE_INK.dark]) {
      expect(theme.coast).toMatch(/^rgba\(/);
      expect(theme.road).toMatch(/^rgba\(/);
      expect(theme.casing).toMatch(/^rgba\(/);
    }
  });
});

describe('reference line widths', () => {
  it('grows with zoom', () => {
    for (const w of [WATER_LINE_W, ROAD_LINE_W]) {
      expect(w.z5).toBeLessThan(w.z10);
      expect(w.z10).toBeLessThan(w.z14);
    }
  });

  it('keeps water ahead of roads at every zoom, so the coast wins the eye', () => {
    expect(WATER_LINE_W.z5).toBeGreaterThan(ROAD_LINE_W.z5);
    expect(WATER_LINE_W.z10).toBeGreaterThan(ROAD_LINE_W.z10);
    expect(WATER_LINE_W.z14).toBeGreaterThan(ROAD_LINE_W.z14);
  });

  it('pins the shipped values', () => {
    expect(WATER_LINE_W).toEqual({ z5: 1.4, z10: 2.4, z14: 3.4 });
    expect(ROAD_LINE_W).toEqual({ z5: 0.8, z10: 1.4, z14: 2.2 });
  });
});
