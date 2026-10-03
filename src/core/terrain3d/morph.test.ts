import {
  anyMorphing,
  clamp01,
  displayedZ,
  MORPH_MS,
  morphFactor,
  pitchRamp,
  RAMP_FULL_DEG,
  RAMP_START_DEG,
  smoothstep,
  TERRAIN_MAX_PITCH_DEG,
} from './morph';

describe('smoothstep and ramp', () => {
  it.each([
    [-1, 0],
    [0, 0],
    [0.5, 0.5],
    [1, 1],
    [2, 1],
  ])('smoothstep(0, 1, %p) = %p', (x, y) => {
    expect(smoothstep(0, 1, x)).toBeCloseTo(y, 12);
  });

  it('degenerate edges step; non-finite reads as 0', () => {
    expect(smoothstep(2, 2, 1)).toBe(0);
    expect(smoothstep(2, 2, 3)).toBe(1);
    expect(smoothstep(0, 1, NaN)).toBe(0);
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(7)).toBe(1);
  });

  it('the ramp is flat below its start and full from its end', () => {
    expect(pitchRamp(0)).toBe(0);
    expect(pitchRamp(RAMP_START_DEG)).toBe(0);
    expect(pitchRamp(RAMP_FULL_DEG)).toBe(1);
    expect(pitchRamp(TERRAIN_MAX_PITCH_DEG)).toBe(1);
    expect(pitchRamp((RAMP_START_DEG + RAMP_FULL_DEG) / 2)).toBeCloseTo(0.5, 12);
  });

  it('the ramp is monotonic and has no jump bigger than a 0.1° step allows', () => {
    let prev = 0;
    for (let p = 0; p <= 80; p += 0.1) {
      const t = pitchRamp(p);
      expect(t).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(t - prev).toBeLessThan(0.0076); // max slope 1.5/20° · 0.1°
      prev = t;
    }
  });
});

describe('time morph', () => {
  it('starts at 1, ends at 0', () => {
    expect(morphFactor(0)).toBe(1);
    expect(morphFactor(-5)).toBe(1);
    expect(morphFactor(MORPH_MS)).toBe(0);
    expect(morphFactor(MORPH_MS * 3)).toBe(0);
    expect(morphFactor(NaN)).toBe(1);
    expect(morphFactor(10, 0)).toBe(0);
  });

  it.each([60, 90, 120, 144])(
    'at %p fps no frame moves the morph more than 3 × dt/duration',
    (fps) => {
      const dt = 1000 / fps;
      let prev = morphFactor(0);
      for (let t = dt; t <= MORPH_MS + dt; t += dt) {
        const m = morphFactor(t);
        expect(prev - m).toBeGreaterThanOrEqual(-1e-12);
        expect(prev - m).toBeLessThanOrEqual((1.5 * dt) / MORPH_MS + 1e-9);
        prev = m;
      }
    },
  );

  it('anyMorphing reports tiles still easing', () => {
    expect(anyMorphing([0, 100], 200)).toBe(true);
    expect(anyMorphing([0, 100], 500)).toBe(false);
    expect(anyMorphing([], 0)).toBe(false);
  });
});

describe('displayed height', () => {
  const base = { hFrom: 1000, hTo: 3000, hRef: 1500, exaggeration: 1.5, ramp: 1 };
  it('settled: (hTo − hRef) · exaggeration', () => {
    expect(displayedZ({ ...base, morph: 0 })).toBe(2250);
  });
  it('start of a morph: exactly the old heights', () => {
    expect(displayedZ({ ...base, morph: 1 })).toBe(-750);
  });
  it('from flat: the morph starts at the flat map', () => {
    expect(displayedZ({ ...base, morph: 1, fromFlat: true })).toBe(0);
    expect(displayedZ({ ...base, morph: 0.5, fromFlat: true })).toBe(1125);
  });
  it('ramp 0 is the flat map whatever else (skirts included)', () => {
    expect(displayedZ({ ...base, morph: 0.3, ramp: 0, skirt: 200 })).toBe(0);
  });
  it('skirts drop below the surface', () => {
    expect(displayedZ({ ...base, morph: 0, skirt: 100 })).toBe(2150);
  });
  it('is continuous in the morph', () => {
    let prev = displayedZ({ ...base, morph: 0 });
    for (let m = 0.01; m <= 1; m += 0.01) {
      const z = displayedZ({ ...base, morph: m });
      expect(Math.abs(z - prev)).toBeLessThan(3000 * 1.5 * 0.0101);
      prev = z;
    }
  });
});
