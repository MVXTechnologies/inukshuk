import {
  FALLBACK_PAPER,
  fogAmount,
  formShade,
  lightDirection,
  luma,
  mix,
  parseColor,
  RELIEF_EXAGGERATION,
  rgbArray,
  scale,
  terrainLook,
  type TerrainLookInput,
} from './look';

describe('parseColor', () => {
  it.each([
    ['#fff', [1, 1, 1]],
    ['#000000', [0, 0, 0]],
    ['#F2ECE0', [0xf2 / 255, 0xec / 255, 0xe0 / 255]],
    ['#1a1f24cc', [0x1a / 255, 0x1f / 255, 0x24 / 255]],
    ['rgb(255, 0, 128)', [1, 0, 128 / 255]],
    ['rgba(74, 62, 45, 0.55)', [74 / 255, 62 / 255, 45 / 255]],
    ['  #ABC ', [0xaa / 255, 0xbb / 255, 0xcc / 255]],
  ])('%p', (css, rgb) => {
    const c = parseColor(css)!;
    for (let i = 0; i < 3; i++) expect(c[i]).toBeCloseTo(rgb[i]!, 9);
  });
  it.each(['', 'red', '#12', '#12345', 'rgb(1,2)', 'hsl(0,0%,0%)'])('rejects %p', (css) => {
    expect(parseColor(css)).toBeNull();
  });
});

describe('colour helpers', () => {
  it('mix / scale / luma', () => {
    expect(mix([0, 0, 0], [1, 1, 1], 0.25)).toEqual([0.25, 0.25, 0.25]);
    expect(mix([0, 0, 0], [1, 1, 1], 4)).toEqual([1, 1, 1]);
    expect(scale([0.5, 0.8, 1], 2)).toEqual([1, 1, 1]);
    expect(luma([1, 1, 1])).toBeCloseTo(1, 9);
    expect(rgbArray([0.1, 0.2, 0.3])).toEqual([0.1, 0.2, 0.3]);
  });
});

describe('terrainLook', () => {
  const paper = '#F2ECE0';
  const night = '#1A1F24';
  const look = (o: Partial<TerrainLookInput>) =>
    terrainLook({ basemap: 'map', dark: false, land: paper, relief: 'natural', ...o });

  it('exaggeration follows the 3D relief setting', () => {
    expect(look({}).exaggeration).toBe(RELIEF_EXAGGERATION.natural);
    expect(look({ relief: 'dramatic' }).exaggeration).toBe(RELIEF_EXAGGERATION.dramatic);
    expect(RELIEF_EXAGGERATION.dramatic).toBeGreaterThan(RELIEF_EXAGGERATION.natural);
  });

  it('light map: fog is exactly the paper; the horizon is a lighter paper', () => {
    const l = look({});
    expect(l.fogColor).toEqual(parseColor(paper));
    expect(luma(l.skyHorizon)).toBeGreaterThan(luma(l.fogColor));
  });

  it('dark map: fog is exactly the stone-night; the zenith is darker, the horizon lighter', () => {
    const l = look({ dark: true, land: night });
    expect(l.fogColor).toEqual(parseColor(night));
    expect(luma(l.skyZenith)).toBeLessThan(luma(l.fogColor));
    expect(luma(l.skyHorizon)).toBeGreaterThan(luma(l.fogColor));
    expect(luma(l.skyHorizon)).toBeLessThan(0.25);
  });

  it('light map with a sky tint leans toward it', () => {
    const plain = look({});
    const tinted = look({ skyTint: '#5B8DB8' });
    const tint = parseColor('#5B8DB8')!;
    const dist = (c: number[]) => Math.hypot(c[0]! - tint[0], c[1]! - tint[1], c[2]! - tint[2]);
    expect(dist(tinted.skyZenith)).toBeLessThan(dist(plain.skyZenith));
  });

  it('an unparsable token falls back to paper', () => {
    expect(look({ land: 'nonsense' }).fogColor).toEqual(FALLBACK_PAPER);
  });

  it('satellite: a daylight sky, bluer at the zenith; dimmer in the dark theme', () => {
    const s = look({ basemap: 'satellite' });
    expect(s.skyZenith[2]).toBeGreaterThan(s.skyZenith[0]);
    expect(luma(s.skyHorizon)).toBeGreaterThan(luma(s.skyZenith));
    const d = look({ basemap: 'satellite', dark: true });
    expect(luma(d.skyHorizon)).toBeLessThan(luma(s.skyHorizon));
    expect(s.fogStartCtc).toBeLessThan(look({}).fogStartCtc); // aerial perspective starts near
  });

  it('form strength is gentle (the drape already carries the shading)', () => {
    for (const l of [look({}), look({ dark: true, land: night }), look({ basemap: 'satellite' })]) {
      expect(l.formStrength).toBeGreaterThan(0);
      expect(l.formStrength).toBeLessThanOrEqual(0.25);
      expect(l.fogEndCtc).toBeGreaterThan(l.fogStartCtc);
    }
  });
});

describe('fog', () => {
  const l = terrainLook({ basemap: 'map', dark: false, land: '#F2ECE0', relief: 'natural' });
  it('is zero before the start and total at the end', () => {
    expect(fogAmount(l, 0)).toBe(0);
    expect(fogAmount(l, l.fogStartCtc)).toBe(0);
    expect(fogAmount(l, l.fogEndCtc)).toBeCloseTo(1, 9);
    expect(fogAmount(l, l.fogEndCtc * 2)).toBe(1);
    expect(fogAmount(l, NaN)).toBe(0);
  });
  it('is monotonic and continuous', () => {
    let prev = 0;
    for (let d = 0; d <= 14; d += 0.01) {
      const f = fogAmount(l, d);
      expect(f).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(f - prev).toBeLessThan(0.03);
      prev = f;
    }
  });
});

describe('light', () => {
  it.each([0, 25, 90, 180, 270, 359])('bearing %p: unit vector, 45° up', (b) => {
    const l = lightDirection(b);
    expect(Math.hypot(...l)).toBeCloseTo(1, 12);
    expect(l[2]).toBeCloseTo(Math.SQRT1_2, 12);
  });
  it('bearing 0: light from the north-north-west (−x, −y)', () => {
    const l = lightDirection(0);
    expect(l[0]).toBeLessThan(0);
    expect(l[1]).toBeLessThan(0); // y grows south: light from the north is −y
    expect(Math.abs(l[1])).toBeGreaterThan(Math.abs(l[0]));
  });
  it('turns with the map (viewport-anchored like the 2D hillshade)', () => {
    const a = lightDirection(0);
    const b = lightDirection(90);
    // rotating the map 90° clockwise turns the light 90° clockwise
    expect(b[0]).toBeCloseTo(-a[1], 9);
    expect(b[1]).toBeCloseTo(a[0], 9);
  });
});

describe('formShade', () => {
  const light = lightDirection(0);
  it('flat ground is unchanged', () => {
    expect(formShade(0, 0, 1, light, 0.2, 1)).toBeCloseTo(1, 12);
  });
  it('a slope facing the light brightens, facing away darkens', () => {
    // facing north-north-west: the ground rises toward the south-east (+x, +y)
    expect(formShade(0.3, 0.6, 1, light, 0.2, 1)).toBeGreaterThan(1);
    expect(formShade(-0.3, -0.6, 1, light, 0.2, 1)).toBeLessThan(1);
  });
  it('ramp 0 or strength 0 leaves the map untouched', () => {
    expect(formShade(1, 1, 1, light, 0.2, 0)).toBe(1);
    expect(formShade(1, 1, 1, light, 0, 1)).toBe(1);
  });
  it('exaggeration deepens the effect', () => {
    const a = formShade(-0.3, -0.6, 1, light, 0.2, 1);
    const b = formShade(-0.3, -0.6, 1.6, light, 0.2, 1);
    expect(b).toBeLessThan(a);
  });
  it('stays in a sane range on a cliff', () => {
    for (const s of [-50, -5, 5, 50]) {
      const f = formShade(s, s, 1.6, light, 0.25, 1);
      expect(f).toBeGreaterThan(0.4);
      expect(f).toBeLessThan(1.6);
    }
  });
});
