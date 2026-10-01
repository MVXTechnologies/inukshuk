import {
  autoContourInterval,
  fract,
  mercatorMetersPerPixel,
  mercatorRowLat,
  SLOPE_BANDS,
  slopeBandColor,
  slopeDegrees,
  SLOPE_BLEND_DEG,
  slopeOverlayColor,
  slopeOverlayMercator,
  slopeOverlayRgba,
  smoothstep,
} from './terrainAnalysis';

const GRID = 9;
const CELL = 30; // metres

/** Heightmap for a plane h = sx·x + sy·y (slopes in m per m; row 0 = north). */
function plane(sx: number, sy: number, grid = GRID, cell = CELL): Float32Array {
  const data = new Float32Array(grid * grid);
  for (let gy = 0; gy < grid; gy++)
    for (let gx = 0; gx < grid; gx++) data[gy * grid + gx] = sx * gx * cell + sy * gy * cell;
  return data;
}

/** Iterate interior cells only (Horn edge cells clamp and halve the gradient). */
function* interior(grid = GRID): Generator<number> {
  for (let gy = 1; gy < grid - 1; gy++) for (let gx = 1; gx < grid - 1; gx++) yield gy * grid + gx;
}

describe('slopeDegrees (Horn 3×3, metre space)', () => {
  it('is 0 on flat ground', () => {
    const s = slopeDegrees(plane(0, 0), GRID, CELL, CELL);
    for (const v of s) expect(v).toBe(0);
  });

  it('recovers the exact slope of an inclined plane (interior cells)', () => {
    for (const [sx, sy] of [
      [Math.tan((30 * Math.PI) / 180), 0],
      [0, Math.tan((45 * Math.PI) / 180)],
      [0.2, -0.3],
    ] as const) {
      const expected = (Math.atan(Math.hypot(sx, sy)) * 180) / Math.PI;
      const s = slopeDegrees(plane(sx, sy), GRID, CELL, CELL);
      for (const i of interior()) expect(s[i]).toBeCloseTo(expected, 4);
    }
  });

  it('respects anisotropic cell sizes', () => {
    // 1 m of height per column at 10 m columns = 0.1 m/m eastward gradient.
    const data = plane(0.1, 0, GRID, 10);
    const s = slopeDegrees(data, GRID, 10, 999); // cellZm irrelevant: no z gradient
    const expected = (Math.atan(0.1) * 180) / Math.PI;
    for (const i of interior()) expect(s[i]).toBeCloseTo(expected, 4);
  });

  it('stays within 0..90', () => {
    const s = slopeDegrees(plane(5, -7), GRID, CELL, CELL);
    for (const v of s) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(90);
    }
  });
});

describe('slope colour bands (CalTopo edges)', () => {
  it('is fully transparent below 27°', () => {
    expect(slopeBandColor(0)).toEqual([0, 0, 0, 0]);
    expect(slopeBandColor(26.999)).toEqual([0, 0, 0, 0]);
  });

  it.each([
    [27, 0], // yellow starts exactly at 27
    [29.999, 0],
    [30, 1], // light orange at 30
    [31.999, 1],
    [32, 2], // orange at 32
    [34.999, 2],
    [35, 3], // red at 35
    [44.999, 3],
    [45, 4], // purple at 45
    [89, 4],
  ])('%p° falls in band %p', (deg, bandIdx) => {
    const band = SLOPE_BANDS[bandIdx]!;
    expect(slopeBandColor(deg)).toEqual([...band.rgb, 255]);
  });
});

describe('autoContourInterval', () => {
  it.each([
    [100, 10],
    [350, 10],
    [351, 25],
    [900, 25],
    [901, 50],
    [1800, 50],
    [1801, 100],
    [4000, 100],
  ])('span %p m → %p m', (span, interval) => {
    expect(autoContourInterval(span)).toBe(interval);
  });
});

describe('slopeOverlayRgba', () => {
  // A west→east ramp rising `rise` metres per cell: every interior cell slopes
  // at atan(rise / cellXm).
  const ramp = (grid: number, risePerCellM: number): Float32Array => {
    const data = new Float32Array(grid * grid);
    for (let y = 0; y < grid; y++)
      for (let x = 0; x < grid; x++) data[y * grid + x] = x * risePerCellM;
    return data;
  };

  it('leaves a flat grid fully transparent', () => {
    const rgba = slopeOverlayRgba(new Float32Array(64).fill(500), 8, 30, 30, 27);
    expect(rgba.every((v) => v === 0)).toBe(true);
  });

  it('paints interior cells with the band colour of their slope', () => {
    // rise 20 m over 30 m ground → atan(2/3) ≈ 33.7° → the 32° band.
    const grid = 9;
    const rgba = slopeOverlayRgba(ramp(grid, 20), grid, 30, 30, 27);
    const centre = (4 * grid + 4) * 4;
    const [r, g, b, a] = slopeBandColor(Math.atan(20 / 30) * (180 / Math.PI));
    expect([rgba[centre], rgba[centre + 1], rgba[centre + 2], rgba[centre + 3]]).toEqual([
      r,
      g,
      b,
      a,
    ]);
  });

  it('hides slopes above the selected ceiling', () => {
    // ≈33.7° cells: visible with max 90, transparent with max 30.
    const grid = 9;
    const centre = (4 * grid + 4) * 4;
    const upTo90 = slopeOverlayRgba(ramp(grid, 20), grid, 30, 30, 27, 90);
    expect(upTo90[centre + 3]).toBe(255);
    const upTo30 = slopeOverlayRgba(ramp(grid, 20), grid, 30, 30, 27, 30);
    expect(upTo30[centre + 3]).toBe(0);
  });

  it('hides bands below the selected floor', () => {
    // ≈33.7° cells: visible at floor 27°/32°, transparent at floor 35°.
    const grid = 9;
    const centre = (4 * grid + 4) * 4;
    const at32 = slopeOverlayRgba(ramp(grid, 20), grid, 30, 30, 32);
    expect(at32[centre + 3]).toBe(255);
    const at35 = slopeOverlayRgba(ramp(grid, 20), grid, 30, 30, 35);
    expect(at35[centre + 3]).toBe(0);
  });
});

describe('GLSL helper mirrors', () => {
  it('smoothstep matches the GLSL definition', () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 9);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(2, 4, 3)).toBeCloseTo(0.5, 9);
  });

  it('fract stays in [0,1) for negatives', () => {
    expect(fract(1.25)).toBeCloseTo(0.25, 9);
    expect(fract(-0.25)).toBeCloseTo(0.75, 9);
  });
});

describe('Web-Mercator pixel geometry', () => {
  it('matches the known equator resolution (156 543 m/px at z0, 256-px tiles)', () => {
    expect(mercatorMetersPerPixel(0, 0)).toBeCloseTo(156543.03, 1);
    expect(mercatorMetersPerPixel(0, 14)).toBeCloseTo(9.5546, 3);
  });

  it('shrinks with cos(latitude) — Québec (47°) at z14 is ~6.5 m/px', () => {
    expect(mercatorMetersPerPixel(47, 14)).toBeCloseTo(9.5546 * Math.cos((47 * Math.PI) / 180), 3);
  });

  it('maps global rows to latitudes (equator mid-world, poles at ±85.05°)', () => {
    expect(mercatorRowLat(128, 0)).toBeCloseTo(0, 9);
    expect(mercatorRowLat(0, 0)).toBeCloseTo(85.0511, 3);
    expect(mercatorRowLat(256, 0)).toBeCloseTo(-85.0511, 3);
    expect(mercatorRowLat(128 * 2 ** 10, 10)).toBeCloseTo(0, 9);
  });
});

describe('slopeOverlayColor (anti-aliased bands, #461)', () => {
  it('is transparent below 27° and outside the window', () => {
    expect(slopeOverlayColor(20, 0)).toEqual([0, 0, 0, 0]);
    expect(slopeOverlayColor(26.9, 27)).toEqual([0, 0, 0, 0]);
    expect(slopeOverlayColor(40, 27, 38)).toEqual([0, 0, 0, 0]);
    expect(slopeOverlayColor(33, 35)).toEqual([0, 0, 0, 0]);
  });

  it('is each band’s own colour, opaque, clear of the band edges', () => {
    for (const [deg, i] of [
      [29, 0],
      [31, 1],
      [33.5, 2],
      [40, 3],
      [60, 4],
    ] as const) {
      expect(slopeOverlayColor(deg, 27)).toEqual([...SLOPE_BANDS[i]!.rgb, 255]);
    }
  });

  it('blends linearly across a band edge — the midpoint is halfway', () => {
    const [r, g, b] = slopeOverlayColor(35, 27);
    const from = SLOPE_BANDS[2]!.rgb;
    const to = SLOPE_BANDS[3]!.rgb;
    expect(r).toBe(Math.round((from[0] + to[0]) / 2));
    expect(g).toBe(Math.round((from[1] + to[1]) / 2));
    expect(b).toBe(Math.round((from[2] + to[2]) / 2));
    // Already the band colour at edge + half the blend.
    expect(slopeOverlayColor(35 + SLOPE_BLEND_DEG / 2 + 0.01, 27)).toEqual([...to, 255]);
  });

  it('fades in from the window floor and out at a ceiling below 90°', () => {
    const a = (deg: number, lo = 27, hi = 90) => slopeOverlayColor(deg, lo, hi)[3];
    expect(a(27)).toBe(0);
    expect(a(27.5)).toBeGreaterThan(0);
    expect(a(27.5)).toBeLessThan(a(28));
    expect(a(27 + SLOPE_BLEND_DEG)).toBe(255);
    expect(a(89.9)).toBe(255); // no fade-out at the natural 90° ceiling
    expect(a(40, 27, 40)).toBe(0);
    expect(a(39, 27, 40)).toBeGreaterThan(0);
    expect(a(39, 27, 40)).toBeLessThan(255);
  });

  it('is continuous — no jump between neighbouring angles', () => {
    let prev = slopeOverlayColor(27, 27);
    for (let deg = 27.05; deg < 70; deg += 0.05) {
      const c = slopeOverlayColor(deg, 27);
      for (let k = 0; k < 4; k++) expect(Math.abs(c[k]! - prev[k]!)).toBeLessThan(40);
      prev = c;
    }
  });
});

describe('slopeOverlayMercator (full-resolution 2D slope, #461)', () => {
  const Z = 14;
  // A tile row near 47° N (Mont Sainte-Anne): global pixel row of a z14 tile.
  const TOP = 5800 * 256;

  /** An east-facing plane of `deg` degrees in true metres on the Mercator mosaic. */
  function mercatorPlane(deg: number, w: number, h: number): Float32Array {
    const d = new Float32Array(w * h);
    const tan = Math.tan((deg * Math.PI) / 180);
    for (let y = 0; y < h; y++) {
      const cell = mercatorMetersPerPixel(mercatorRowLat(TOP + y + 0.5, Z), Z);
      for (let x = 0; x < w; x++) d[y * w + x] = 1000 + tan * x * cell;
    }
    return d;
  }

  it('reads a 33.5° plane as the orange band, using the true Mercator cell size', () => {
    const img = slopeOverlayMercator(mercatorPlane(33.5, 16, 16), 16, 16, Z, TOP, 27);
    expect(img.width).toBe(16);
    const i = (8 * 16 + 8) * 4;
    expect([...img.rgba.slice(i, i + 4)]).toEqual([...SLOPE_BANDS[2]!.rgb, 255]);
  });

  it('leaves flat ground and slopes outside the window transparent', () => {
    const flat = slopeOverlayMercator(new Float32Array(64).fill(500), 8, 8, Z, TOP, 27);
    expect(flat.rgba.every((v) => v === 0)).toBe(true);
    const steep = slopeOverlayMercator(mercatorPlane(50, 8, 8), 8, 8, Z, TOP, 27, 40);
    expect(steep.rgba[(4 * 8 + 4) * 4 + 3]).toBe(0);
  });

  it('block-averages the slope down by `step` (ceil for ragged edges)', () => {
    const img = slopeOverlayMercator(mercatorPlane(40, 10, 7), 10, 7, Z, TOP, 27, 90, 3);
    expect(img.width).toBe(4);
    expect(img.height).toBe(3);
    expect(img.rgba).toHaveLength(4 * 3 * 4);
    // Interior block of a uniform 40° plane: the red band.
    const i = (1 * 4 + 1) * 4;
    expect([...img.rgba.slice(i, i + 4)]).toEqual([...SLOPE_BANDS[3]!.rgb, 255]);
  });

  it('treats a step below 1 as full resolution', () => {
    const img = slopeOverlayMercator(mercatorPlane(40, 6, 6), 6, 6, Z, TOP, 27, 90, 0);
    expect([img.width, img.height]).toEqual([6, 6]);
  });
});
