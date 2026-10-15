import {
  autoContourInterval,
  fract,
  mercatorMetersPerPixel,
  mercatorRowLat,
  SLOPE_BANDS,
  slopeBandColor,
  SLOPE_BLEND_DEG,
  slopeOverlayColor,
  slopeOverlayIndexed,
  slopeOverlayMercator,
  slopePalette,
  slopePaletteIndex,
  NO_SLOPE_FILTER,
  SLOPE_TRACE_ALPHA,
  slopeFilterActive,
  slopeFilterPass,
  type SlopeFilter,
  smoothstep,
} from './terrainAnalysis';

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
    expect(slopeOverlayColor(27 - SLOPE_BLEND_DEG / 2, 27)).toEqual([0, 0, 0, 0]);
    expect(slopeOverlayColor(NaN, 27)).toEqual([0, 0, 0, 0]);
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

  it('fades across the window floor and ceiling CENTRED on them, like the band edges (#722)', () => {
    const a = (deg: number, lo = 27, hi = 90) => slopeOverlayColor(deg, lo, hi)[3];
    const half = SLOPE_BLEND_DEG / 2;
    // Half-way exactly at the legend's 27°, fully drawn 0.75° inside the band
    // (the old ramp started AT 27°: a 27.75° slope drew at half opacity).
    expect(a(27)).toBe(128);
    expect(a(27 + half)).toBe(255);
    expect(a(27.5)).toBeGreaterThan(a(27));
    expect(a(27 - half)).toBe(0);
    expect(a(89.9)).toBe(255); // no fade-out at the natural 90° ceiling
    expect(a(40, 27, 40)).toBe(128);
    expect(a(40 - half, 27, 40)).toBe(255);
    expect(a(40 + half, 27, 40)).toBe(0);
    // The fade below the floor wears the floor band's colour, not black.
    expect(slopeOverlayColor(26.8, 27).slice(0, 3)).toEqual([...SLOPE_BANDS[0]!.rgb]);
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

  it('paints the mosaic’s outer ring like its interior — no halved edge slope (#722)', () => {
    const img = slopeOverlayMercator(mercatorPlane(33.5, 8, 8), 8, 8, Z, TOP, 27);
    const orange = [...SLOPE_BANDS[2]!.rgb, 255];
    for (const [x, y] of [
      [0, 0],
      [7, 0],
      [0, 7],
      [7, 7],
      [0, 4],
      [7, 4],
      [4, 0],
      [4, 7],
    ] as const) {
      const i = (y * 8 + x) * 4;
      expect([...img.rgba.slice(i, i + 4)]).toEqual(orange);
    }
  });

  it('draws a Terrarium void as nothing — not a purple cliff ring around it (#722)', () => {
    const d = new Float32Array(64).fill(250);
    d[3 * 8 + 3] = -32768;
    const img = slopeOverlayMercator(d, 8, 8, Z, TOP, 27);
    expect(img.rgba.every((v) => v === 0)).toBe(true);
  });

  it('indexed and RGBA overlays agree pixel for pixel', () => {
    const d = mercatorPlane(36, 16, 16);
    for (let i = 0; i < d.length; i += 7) d[i] = d[i]! + 3; // some texture
    const rgba = slopeOverlayMercator(d, 16, 16, Z, TOP, 27, 90, 2);
    const ix = slopeOverlayIndexed(d, 16, 16, Z, TOP, 27, 90, 2);
    expect([ix.width, ix.height]).toEqual([8, 8]);
    for (let o = 0; o < 64; o++) {
      const k = ix.indices[o]!;
      expect(rgba.rgba[o * 4 + 3]).toBe(k === 0 ? 0 : ix.palette.alpha[k]);
    }
  });
});

describe('slopePalette (indexed overlay, #722)', () => {
  it('reproduces the drawn colour of every slope within ±3 / 255 (premultiplied)', () => {
    for (const [lo, hi] of [
      [27, 90],
      [30, 45],
      [33.3, 61.7],
    ] as const) {
      const p = slopePalette(lo, hi);
      expect(p.count).toBeLessThanOrEqual(256);
      let worst = 0;
      for (let deg = 0; deg <= 90; deg += 0.001) {
        const want = slopeOverlayColor(deg, lo, hi);
        const k = slopePaletteIndex(p, deg);
        const got =
          k === 0
            ? [0, 0, 0, 0]
            : [p.rgb[k * 3]!, p.rgb[k * 3 + 1]!, p.rgb[k * 3 + 2]!, p.alpha[k]!];
        // Compare what is drawn: colour premultiplied by alpha, and alpha.
        const pre = (c: number[], i: number) => (i === 3 ? c[3]! : (c[i]! * c[3]!) / 255);
        for (let c = 0; c < 4; c++) worst = Math.max(worst, Math.abs(pre(got, c) - pre(want, c)));
      }
      expect(worst).toBeLessThanOrEqual(3);
    }
  });

  it('maps no-data and negative input to the transparent entry', () => {
    const p = slopePalette(27);
    expect(slopePaletteIndex(p, NaN)).toBe(0);
    expect(slopePaletteIndex(p, -1)).toBe(0);
    expect(p.alpha[0]).toBe(0);
  });
});

describe('slope filter: aspect sectors × altitude range × steepness (#723)', () => {
  const Z = 14;
  const TOP = 5800 * 256;
  const W = 12;
  // Rises 1 m… eastward at 40°: faces WEST (sector 6), elevations 1000 → ~1060 m.
  function westFace(): Float32Array {
    const d = new Float32Array(W * W);
    const tan = Math.tan((40 * Math.PI) / 180);
    for (let y = 0; y < W; y++) {
      const cell = mercatorMetersPerPixel(mercatorRowLat(TOP + y + 0.5, Z), Z);
      for (let x = 0; x < W; x++) d[y * W + x] = 1000 + tan * x * cell;
    }
    return d;
  }
  const red = SLOPE_BANDS[3]!.rgb;
  const traceA = Math.round(255 * SLOPE_TRACE_ALPHA);
  const alphaAt = (img: { rgba: Uint8Array }, x: number, y: number) =>
    img.rgba[(y * W + x) * 4 + 3]!;
  const run = (d: Float32Array, f: SlopeFilter, lo = 27, hi = 90) =>
    slopeOverlayMercator(d, W, W, Z, TOP, lo, hi, 1, f);
  const sector = (...s: number[]) => s.reduce((m, k) => m | (1 << k), 0);

  it('no filter (all 8 sectors, no altitude bounds) is exactly the unfiltered overlay', () => {
    const d = westFace();
    expect(slopeFilterActive(NO_SLOPE_FILTER)).toBe(false);
    expect(run(d, NO_SLOPE_FILTER).rgba).toEqual(slopeOverlayMercator(d, W, W, Z, TOP, 27).rgba);
    expect(slopeFilterActive({ aspectMask: 0xff, minAltM: 0, maxAltM: null })).toBe(true);
  });

  it('aspect: the selected sector draws full colour, any other the faint trace', () => {
    const d = westFace();
    const west = run(d, { aspectMask: sector(6), minAltM: null, maxAltM: null });
    const north = run(d, { aspectMask: sector(0, 1, 2, 3, 4, 5, 7), minAltM: null, maxAltM: null });
    for (let i = 0; i < W * W; i++) {
      expect([...west.rgba.slice(i * 4, i * 4 + 4)]).toEqual([...red, 255]);
      expect([...north.rgba.slice(i * 4, i * 4 + 4)]).toEqual([...red, traceA]);
    }
  });

  it('altitude: inclusive bounds, outside → trace', () => {
    const d = westFace();
    // Bounds exactly on column 3's and column 8's elevations (row 5).
    const lo = d[5 * W + 3]!;
    const hi = d[5 * W + 8]!;
    const img = run(d, { aspectMask: 0xff, minAltM: lo, maxAltM: hi });
    for (let x = 0; x < W; x++) {
      expect(alphaAt(img, x, 5)).toBe(x >= 3 && x <= 8 ? 255 : traceA);
    }
    // One-sided bounds.
    const above = run(d, { aspectMask: 0xff, minAltM: lo, maxAltM: null });
    expect(alphaAt(above, 2, 5)).toBe(traceA);
    expect(alphaAt(above, 11, 5)).toBe(255);
    const below = run(d, { aspectMask: 0xff, minAltM: null, maxAltM: hi });
    expect(alphaAt(below, 9, 5)).toBe(traceA);
    expect(alphaAt(below, 0, 5)).toBe(255);
  });

  it('all three must match; outside the steepness window stays transparent whatever the filter', () => {
    const d = westFace();
    const lo = d[5 * W + 3]!;
    const both = run(d, { aspectMask: sector(6), minAltM: lo, maxAltM: null });
    const aspectOnly = run(d, { aspectMask: sector(6), minAltM: 1e5, maxAltM: null });
    const altOnly = run(d, { aspectMask: sector(2), minAltM: lo, maxAltM: null });
    expect(alphaAt(both, 6, 5)).toBe(255);
    expect(alphaAt(aspectOnly, 6, 5)).toBe(traceA);
    expect(alphaAt(altOnly, 6, 5)).toBe(traceA);
    // A 40° face with the window 27–35°: transparent, filtered or not.
    const outside = run(d, { aspectMask: sector(6), minAltM: lo, maxAltM: null }, 27, 35);
    expect(outside.rgba.every((v) => v === 0)).toBe(true);
  });

  it('no data never passes and never paints', () => {
    const d = westFace();
    d[5 * W + 5] = NaN;
    const img = run(d, { aspectMask: 0xff, minAltM: 0, maxAltM: 5000 });
    expect(alphaAt(img, 5, 5)).toBe(0);
    expect(alphaAt(img, 4, 5)).toBe(255); // neighbours keep their exact slope
    expect(slopeFilterPass({ aspectMask: 0xff, minAltM: 0, maxAltM: null }, 90, NaN)).toBe(false);
    expect(slopeFilterPass({ aspectMask: 0xff, minAltM: 0, maxAltM: null }, 90, -32768)).toBe(
      false,
    );
    expect(slopeFilterPass({ aspectMask: sector(2), minAltM: null, maxAltM: null }, NaN, 10)).toBe(
      false,
    );
    expect(slopeFilterPass(NO_SLOPE_FILTER, NaN, NaN)).toBe(true);
  });

  it('decides a downsampled block by the majority of its pixels', () => {
    const d = westFace();
    // Altitude cut between columns 4 and 5: blocks (4,5) straddle? With step 2
    // the blocks are columns {4,5}: one passes, one fails → half → full colour.
    const lo = d[5 * W + 5]!;
    const img = slopeOverlayMercator(d, W, W, Z, TOP, 27, 90, 2, {
      aspectMask: 0xff,
      minAltM: lo,
      maxAltM: null,
    });
    const a = (bx: number) => img.rgba[(2 * 6 + bx) * 4 + 3]!;
    expect(a(1)).toBe(traceA); // columns 2,3: both below
    expect(a(2)).toBe(255); // columns 4,5: one of two passes (≥ half)
    expect(a(3)).toBe(255);
  });

  it('the trace palette keeps the full colours exact and the trace within ±3 / 255', () => {
    const p = slopePalette(27, 90, true);
    expect(p.count).toBeLessThanOrEqual(256);
    let worst = 0;
    const pre = (c: number[], i: number) => (i === 3 ? c[3]! : (c[i]! * c[3]!) / 255);
    for (let deg = 0; deg <= 90; deg += 0.001) {
      for (const trace of [false, true]) {
        const w = slopeOverlayColor(deg, 27, 90);
        const want = trace ? [w[0], w[1], w[2], Math.round(w[3] * SLOPE_TRACE_ALPHA)] : w;
        const k = slopePaletteIndex(p, deg, trace);
        const got =
          k === 0
            ? [0, 0, 0, 0]
            : [p.rgb[k * 3]!, p.rgb[k * 3 + 1]!, p.rgb[k * 3 + 2]!, p.alpha[k]!];
        for (let c = 0; c < 4; c++) worst = Math.max(worst, Math.abs(pre(got, c) - pre(want, c)));
      }
    }
    expect(worst).toBeLessThanOrEqual(3);
  });
});
