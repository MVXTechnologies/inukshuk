import { lightDirection, luma, terrainLook } from './look';
import { DEFAULT_SURFACE, lambertFor, mixRgb, shadeSurface } from './surface';

const look = terrainLook({
  basemap: 'map',
  dark: false,
  land: '#F2ECE0',
  landAlt: '#E6DFCF',
  water: '#5C93B7',
  relief: 'natural',
});
const night = terrainLook({
  basemap: 'map',
  dark: true,
  land: '#1A1F24',
  landAlt: '#232A30',
  water: '#5C93B7',
  relief: 'natural',
});
const light = lightDirection(0);
const base = {
  palette: look.surface,
  heightM: 800,
  slopeX: 0,
  slopeY: 0,
  exaggeration: 1,
  light,
  water: 0,
  glacier: 0,
};

describe('lambert', () => {
  it('flat ground gets the light’s own z', () => {
    expect(lambertFor(0, 0, 1, light)).toBeCloseTo(light[2], 12);
  });
  it('faces toward the light are brighter, away darker, never negative', () => {
    expect(lambertFor(0.5, 0.8, 1, light)).toBeGreaterThan(light[2]);
    expect(lambertFor(-0.5, -0.8, 1, light)).toBeLessThan(light[2]);
    expect(lambertFor(-50, -50, 1, light)).toBe(0);
  });
});

describe('shadeSurface (map style)', () => {
  it('flat ground at low altitude is the paper itself', () => {
    const c = shadeSurface(base);
    for (let i = 0; i < 3; i++) expect(c[i]).toBeCloseTo(look.surface.land[i]!, 6);
  });
  it('a face turned away from the sun takes the warm shadow, a lit face the highlight', () => {
    const away = shadeSurface({ ...base, slopeX: -0.6, slopeY: -0.9 });
    const lit = shadeSurface({ ...base, slopeX: 0.6, slopeY: 0.9 });
    expect(luma(away)).toBeLessThan(luma(look.surface.land));
    expect(luma(lit)).toBeGreaterThanOrEqual(luma(look.surface.land) - 1e-9);
    // Warm (umber) shadows on paper: red ≥ blue.
    expect(away[0]).toBeGreaterThan(away[2]);
  });
  it('rock creeps in only at altitude and stays subtle', () => {
    const low = shadeSurface({ ...base, heightM: 1500 });
    const high = shadeSurface({ ...base, heightM: 4000 });
    const full = mixRgb(look.surface.land, look.surface.rock, DEFAULT_SURFACE.rockMax);
    for (let i = 0; i < 3; i++) {
      expect(low[i]).toBeCloseTo(look.surface.land[i]!, 6);
      expect(high[i]).toBeCloseTo(full[i]!, 6);
    }
  });
  it('sea level reads as water, flat (no relief shading)', () => {
    const sea = shadeSurface({ ...base, heightM: 0, slopeX: -0.5, slopeY: -0.5 });
    for (let i = 0; i < 3; i++) expect(sea[i]).toBeCloseTo(look.surface.water[i]!, 6);
  });
  it('the water mask paints lakes above sea level; the glacier mask paints ice', () => {
    const lake = shadeSurface({ ...base, heightM: 1800, water: 1 });
    for (let i = 0; i < 3; i++) expect(lake[i]).toBeCloseTo(look.surface.water[i]!, 6);
    const ice = shadeSurface({ ...base, heightM: 1000, glacier: 1 });
    for (let i = 0; i < 3; i++) expect(ice[i]).toBeCloseTo(look.surface.glacier[i]!, 6);
  });
  it('steep slopes darken more than gentle ones facing the same way', () => {
    const gentle = shadeSurface({ ...base, slopeX: -0.1, slopeY: -0.15 });
    const steep = shadeSurface({ ...base, slopeX: -0.8, slopeY: -1.2 });
    expect(luma(steep)).toBeLessThan(luma(gentle));
  });
  it('exaggeration deepens the shading', () => {
    const a = shadeSurface({ ...base, slopeX: -0.3, slopeY: -0.4, exaggeration: 1 });
    const b = shadeSurface({ ...base, slopeX: -0.3, slopeY: -0.4, exaggeration: 1.6 });
    expect(luma(b)).toBeLessThan(luma(a));
  });
  it('stone night: shadows go toward black, the paper stays dark', () => {
    const c = shadeSurface({ ...base, palette: night.surface, slopeX: -0.6, slopeY: -0.9 });
    expect(luma(c)).toBeLessThan(luma(night.surface.land));
    const lit = shadeSurface({ ...base, palette: night.surface, slopeX: 0.6, slopeY: 0.9 });
    expect(luma(lit)).toBeLessThan(0.3);
  });
  it('colours stay in gamut over a sweep', () => {
    for (const s of [-3, -1, -0.2, 0, 0.2, 1, 3]) {
      for (const h of [-10, 0, 500, 2500, 4500]) {
        for (const p of [look.surface, night.surface]) {
          const c = shadeSurface({ ...base, palette: p, slopeX: s, slopeY: -s / 2, heightM: h });
          for (const v of c) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });
});
