import {
  aspectDegrees,
  autoContourInterval,
  bakeHillshadeIntoRgba,
  contourShadeForLuminance,
  contourStrength,
  fract,
  hillshadeFactor,
  hypsoBandStart,
  hypsoColor,
  hypsoRampRgba,
  luminance601,
  mercatorMetersPerPixel,
  mercatorRowLat,
  multidirHillshade,
  skyGradientColor,
  SKY_STOPS,
  SLOPE_BANDS,
  slopeBandColor,
  slopeDegrees,
  SLOPE_BLEND_DEG,
  slopeOverlayColor,
  slopeOverlayMercator,
  slopeOverlayRgba,
  slopeRampRgba,
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

describe('aspectDegrees', () => {
  it.each([
    // [sx, sy, expected downslope compass deg]
    [-0.5, 0, 90], // falls to the east → faces east
    [0.5, 0, 270], // falls to the west
    [0, 0.5, 0], // rows grow southward; rising south = falls to the north
    [0, -0.5, 180], // falls to the south
  ])('plane sx=%p sy=%p → aspect %p°', (sx, sy, expected) => {
    const a = aspectDegrees(plane(sx, sy), GRID, CELL, CELL);
    for (const i of interior()) expect(a[i]).toBeCloseTo(expected, 4);
  });

  it('is NaN on flat ground', () => {
    const a = aspectDegrees(plane(0, 0), GRID, CELL, CELL);
    for (const v of a) expect(Number.isNaN(v)).toBe(true);
  });
});

describe('multidirHillshade', () => {
  it('shades flat ground to sin(45°)', () => {
    const h = multidirHillshade(plane(0, 0), GRID, CELL, CELL);
    for (const v of h) expect(v).toBeCloseTo(Math.SQRT1_2, 5);
  });

  it('stays within [0, 1] on rugged terrain', () => {
    const data = new Float32Array(GRID * GRID);
    for (let i = 0; i < data.length; i++)
      data[i] = 500 * Math.sin(i * 12.9898) + 200 * Math.cos(i * 78.233);
    const h = multidirHillshade(data, GRID, CELL, CELL);
    for (const v of h) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('lights west-facing slopes more than east-facing ones (suns at 225–360°)', () => {
    const west = multidirHillshade(plane(0.6, 0), GRID, CELL, CELL); // falls west? sx>0 → falls to -x = west
    const east = multidirHillshade(plane(-0.6, 0), GRID, CELL, CELL);
    const mid = Math.floor((GRID * GRID) / 2);
    expect(west[mid]!).toBeGreaterThan(east[mid]!);
  });

  it('darkens concavities relative to a uniform slope (cavity term)', () => {
    const slope = plane(0.3, 0);
    const valley = Float32Array.from(slope);
    const mid = Math.floor(GRID / 2) * GRID + Math.floor(GRID / 2);
    valley[mid] = valley[mid]! - 20; // dig a hollow at the centre
    const flatShade = multidirHillshade(slope, GRID, CELL, CELL);
    const valleyShade = multidirHillshade(valley, GRID, CELL, CELL);
    expect(valleyShade[mid]!).toBeLessThan(flatShade[mid]!);
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

  it('builds a 256×1 RGBA ramp matching the band function at texel centres', () => {
    const ramp = slopeRampRgba();
    expect(ramp.length).toBe(256 * 4);
    for (const i of [0, 76, 77, 100, 128, 200, 255]) {
      const deg = ((i + 0.5) / 256) * 90;
      const [r, g, b, a] = slopeBandColor(deg);
      expect([ramp[i * 4], ramp[i * 4 + 1], ramp[i * 4 + 2], ramp[i * 4 + 3]]).toEqual([
        r,
        g,
        b,
        a,
      ]);
    }
  });
});

describe('hypsometric ramp', () => {
  it('interpolates between the stops and clamps outside [0,1]', () => {
    expect(hypsoColor(0)).toEqual([88, 128, 86]);
    expect(hypsoColor(-1)).toEqual([88, 128, 86]);
    expect(hypsoColor(1)).toEqual([235, 235, 235]);
    expect(hypsoColor(2)).toEqual([235, 235, 235]);
    // Midway through the first segment (t=0.125 of 4 segments → f=0.5).
    const [r] = hypsoColor(0.125);
    expect(r).toBeCloseTo((88 + 140) / 2, 6);
  });

  it('builds an opaque 256×1 RGBA ramp', () => {
    const ramp = hypsoRampRgba();
    expect(ramp.length).toBe(256 * 4);
    for (let i = 0; i < 256; i++) expect(ramp[i * 4 + 3]).toBe(255);
  });

  it('bands elevations to their band-start value', () => {
    expect(hypsoBandStart(1234, 100)).toBe(1200);
    expect(hypsoBandStart(1299.9, 100)).toBe(1200);
    expect(hypsoBandStart(-51, 50)).toBe(-100);
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

describe('contourStrength (fwidth isolines, shader mirror)', () => {
  it('is maximal exactly on a contour line', () => {
    const { minor, combined } = contourStrength(250, 25, 5, 0.5);
    expect(minor).toBe(1);
    expect(combined).toBeGreaterThan(0);
  });

  it('is zero between lines', () => {
    const { minor, major, combined } = contourStrength(262.5, 25, 5, 0.5);
    expect(minor).toBe(0);
    expect(major).toBe(0);
    expect(combined).toBe(0);
  });

  it('majors are stronger than minors in the combined weight', () => {
    const onMajor = contourStrength(500, 25, 4, 0.5); // 500 = 4·125? 25·4=100 → 500 is a major
    const onMinor = contourStrength(525, 25, 4, 0.5); // 525 not divisible by 100
    expect(onMajor.major).toBe(1);
    expect(onMajor.combined).toBeCloseTo(0.55, 9);
    expect(onMinor.combined).toBeCloseTo(0.3, 9);
  });

  it('fades minors out as line density approaches aliasing', () => {
    const sparse = contourStrength(250, 25, 5, 25 * 0.2); // wpx/interval = 0.2 → below fade start
    const dense = contourStrength(250, 25, 5, 25 * 0.6); // past fade end → minors gone
    expect(sparse.minor).toBeGreaterThan(0.9);
    expect(dense.minor).toBe(0);
  });

  it('guards against zero fwidth', () => {
    const { minor } = contourStrength(250, 25, 5, 0);
    expect(minor).toBe(1);
    expect(Number.isFinite(minor)).toBe(true);
  });
});

describe('hillshade baking', () => {
  it('hillshadeFactor is ≈1 on flat ground and monotonic in shade', () => {
    expect(hillshadeFactor(Math.SQRT1_2)).toBeCloseTo(1, 1);
    expect(hillshadeFactor(0)).toBeLessThan(hillshadeFactor(0.5));
    expect(hillshadeFactor(0.5)).toBeLessThan(hillshadeFactor(1));
    expect(hillshadeFactor(0)).toBeGreaterThanOrEqual(0);
    expect(hillshadeFactor(1)).toBeLessThanOrEqual(1.35);
  });

  it('bakes shade into RGBA pixels in place, leaving alpha alone', () => {
    const w = 4;
    const h = 4;
    const rgba = new Uint8Array(w * h * 4).fill(200);
    const shade = new Float32Array(4).fill(0.2); // 2×2 dark shade grid
    bakeHillshadeIntoRgba(rgba, w, h, shade, 2);
    for (let i = 0; i < w * h; i++) {
      expect(rgba[i * 4]).toBeLessThan(200); // darkened
      expect(rgba[i * 4]).toBeGreaterThanOrEqual(0);
      expect(rgba[i * 4 + 3]).toBe(200); // alpha untouched
    }
  });

  it('never overflows 255 on bright shade', () => {
    const rgba = new Uint8Array(4 * 4).fill(250);
    bakeHillshadeIntoRgba(rgba, 2, 2, new Float32Array([1, 1, 1, 1]), 2);
    for (let i = 0; i < 4; i++) expect(rgba[i * 4]).toBeLessThanOrEqual(255);
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

describe('contourShadeForLuminance', () => {
  it('is white over dark surfaces and black over bright ones', () => {
    expect(contourShadeForLuminance(0)).toBe(1);
    expect(contourShadeForLuminance(0.2)).toBe(1); // below the dark threshold
    expect(contourShadeForLuminance(1)).toBe(0);
    expect(contourShadeForLuminance(0.8)).toBe(0); // above the bright threshold
  });

  it('transitions smoothly and monotonically between the thresholds', () => {
    const mid = contourShadeForLuminance(0.5);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(contourShadeForLuminance(0.4)).toBeGreaterThan(contourShadeForLuminance(0.6));
  });

  it('luminance601 weights green highest', () => {
    expect(luminance601(1, 1, 1)).toBeCloseTo(1);
    expect(luminance601(0, 1, 0)).toBeGreaterThan(luminance601(1, 0, 0));
    expect(luminance601(1, 0, 0)).toBeGreaterThan(luminance601(0, 0, 1));
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

describe('skyGradientColor', () => {
  it('returns the horizon colour at and below the horizon', () => {
    expect(skyGradientColor(0)).toEqual([...SKY_STOPS.horizon]);
    expect(skyGradientColor(-0.5)).toEqual([...SKY_STOPS.horizon]);
  });

  it('returns the zenith colour straight up', () => {
    const c = skyGradientColor(1);
    for (let i = 0; i < 3; i++) expect(c[i]).toBeCloseTo(SKY_STOPS.zenith[i]!, 9);
  });

  it('blends monotonically (sky gets bluer with height)', () => {
    const low = skyGradientColor(0.1);
    const mid = skyGradientColor(0.4);
    const high = skyGradientColor(0.8);
    expect(low[2]!).toBeGreaterThanOrEqual(mid[2]!); // blue channel: haze is brightest
    expect(low[0]!).toBeGreaterThan(mid[0]!); // red drops toward zenith blue
    expect(mid[0]!).toBeGreaterThan(high[0]!);
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
