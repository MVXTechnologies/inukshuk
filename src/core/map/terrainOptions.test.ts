import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DEFAULT_HILLSHADE_STRENGTH,
  DEFAULT_PEAK_DENSITY,
  HILLSHADE_STRENGTHS,
  hillshadeLook,
  isHillshadeStrength,
  isPeakDensity,
  PEAK_DENSITIES,
  PEAK_DENSITY_LABEL,
  PEAK_LEAD,
  PEAK_MAX_LEAD,
  SHADING_LABEL,
  SHADING_LEVELS,
} from './terrainOptions';

/** Alpha of an `rgba(r, g, b, a)` string. */
const alpha = (c: string): number => Number(/,\s*([\d.]+)\)$/.exec(c)?.[1]);

describe('peak density', () => {
  it('defaults to normal, one zoom earlier than the original ladder', () => {
    expect(DEFAULT_PEAK_DENSITY).toBe('normal');
    expect(PEAK_LEAD.fewer).toBe(0);
    expect(PEAK_LEAD.normal).toBe(1);
    expect(PEAK_LEAD.more).toBe(2);
  });

  it('never asks for a lead the tiles do not carry', () => {
    for (const d of PEAK_DENSITIES) {
      expect(PEAK_LEAD[d]).toBeGreaterThanOrEqual(0);
      expect(PEAK_LEAD[d]).toBeLessThanOrEqual(PEAK_MAX_LEAD);
      expect(Number.isInteger(PEAK_LEAD[d])).toBe(true); // filters see integer tile zooms
    }
    expect(Math.max(...PEAK_DENSITIES.map((d) => PEAK_LEAD[d]))).toBe(PEAK_MAX_LEAD);
  });

  it('matches the tileset builder’s PEAK_MAX_LEAD', () => {
    const py = readFileSync(join(__dirname, '../../../infra/tiles/nas/peaks_geojson.py'), 'utf8');
    expect(py).toMatch(new RegExp(`^PEAK_MAX_LEAD = ${PEAK_MAX_LEAD}$`, 'm'));
  });

  it('validates persisted values', () => {
    for (const d of PEAK_DENSITIES) expect(isPeakDensity(d)).toBe(true);
    for (const junk of ['', 'many', 2, null, undefined]) expect(isPeakDensity(junk)).toBe(false);
  });

  it('labels every density', () => {
    expect(PEAK_DENSITIES.map((d) => PEAK_DENSITY_LABEL[d])).toEqual(['Fewer', 'Normal', 'More']);
  });
});

describe('shading', () => {
  it('offers None / Light / Medium / Heavy, Medium by default', () => {
    expect(SHADING_LEVELS.map((l) => SHADING_LABEL[l])).toEqual([
      'None',
      'Light',
      'Medium',
      'Heavy',
    ]);
    expect(DEFAULT_HILLSHADE_STRENGTH).toBe('medium');
    expect(isHillshadeStrength('none')).toBe(false); // None is the switch off
    for (const s of HILLSHADE_STRENGTHS) expect(isHillshadeStrength(s)).toBe(true);
    expect(isHillshadeStrength(0.5)).toBe(false);
  });

  it('keeps Medium on the light map exactly the pre-#461 look', () => {
    expect(hillshadeLook('medium', false)).toEqual({
      exaggeration: 0.45,
      shadowColor: 'rgba(74, 62, 45, 0.55)',
      highlightColor: 'rgba(255, 250, 240, 0.25)',
      accentColor: 'rgba(120, 105, 80, 0.3)',
    });
  });

  it.each([false, true])('grows strictly from Light to Heavy (dark=%s)', (dark) => {
    const [l, m, h] = HILLSHADE_STRENGTHS.map((s) => hillshadeLook(s, dark));
    expect(l!.exaggeration).toBeLessThan(m!.exaggeration);
    expect(m!.exaggeration).toBeLessThan(h!.exaggeration);
    expect(alpha(l!.shadowColor)).toBeLessThan(alpha(m!.shadowColor));
    expect(alpha(m!.shadowColor)).toBeLessThan(alpha(h!.shadowColor));
    for (const look of [l, m, h]) {
      expect(look!.exaggeration).toBeGreaterThan(0);
      expect(look!.exaggeration).toBeLessThanOrEqual(1);
    }
  });

  it('shades the dark map in near-black with a faint highlight, so it stays visible', () => {
    for (const s of HILLSHADE_STRENGTHS) {
      const dark = hillshadeLook(s, true);
      const light = hillshadeLook(s, false);
      expect(dark.shadowColor).toMatch(/^rgba\(0, 0, 0, /);
      expect(alpha(dark.shadowColor)).toBeGreaterThan(alpha(light.shadowColor));
      expect(alpha(dark.highlightColor)).toBeLessThan(alpha(light.highlightColor));
      expect(dark.exaggeration).toBe(light.exaggeration);
    }
  });
});
