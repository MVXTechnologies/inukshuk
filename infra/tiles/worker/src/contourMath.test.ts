/**
 * Runs under the app's jest (the Worker has no test runner of its own):
 * contourMath.ts is pure, so it needs nothing from the Workers runtime.
 */
import { deflateSync, inflateSync } from 'zlib';

import {
  adaptiveLevels,
  cellReliefAt,
  cleanIsolines,
  coarsening,
  CONTOUR_VERSION,
  contourLevels,
  contourR2Key,
  decodeTerrariumPng,
  encodeContourMvt,
  isTinyRing,
  LEVEL_LADDER,
  Lru,
  MAX_CROSSINGS_PER_CELL,
  MAX_SLOPE_CLASS,
  meanPixelRelief,
  MIN_SLOPE_RUN,
  simplifyLine,
  simplifyTolerance,
  slopeClass,
  splitBySlope,
  steepestBlockRelief,
  tinyRingSpan,
  UnsupportedPng,
} from './contourMath';

const inflate = async (d: Uint8Array) => new Uint8Array(inflateSync(d));

describe('contour levels', () => {
  it('keeps the zoom table', () => {
    expect(contourLevels(8)).toEqual([100, 500]);
    expect(contourLevels(10)).toEqual([50, 250]);
    expect(contourLevels(11)).toEqual([25, 100]);
    expect(contourLevels(12)).toEqual([20, 100]);
    expect(contourLevels(14)).toEqual([10, 50]);
  });

  it('every ladder step keeps majors a multiple of minors, coarser each step', () => {
    let prev = 0;
    for (const [minor, major] of LEVEL_LADDER) {
      expect(major % minor).toBe(0);
      expect(minor).toBeGreaterThan(prev);
      prev = minor;
    }
    for (const z of [8, 9, 10, 11, 12, 13, 14]) {
      expect(LEVEL_LADDER).toContainEqual(contourLevels(z));
    }
  });

  it('leaves gentle terrain on its zoom interval (Québec, Mont-Sainte-Anne)', () => {
    // Steepest-tile estimates measured there: ≤ 1.1 crossings per cell.
    for (const z of [10, 11, 12, 13, 14]) {
      const [minor] = contourLevels(z);
      expect(adaptiveLevels(z, 1.1 * minor)).toEqual(contourLevels(z));
      expect(adaptiveLevels(z, 0)).toEqual(contourLevels(z));
      expect(adaptiveLevels(z, Number.NaN)).toEqual(contourLevels(z));
    }
  });

  it('steps steep regions up the ladder until they fit the budget', () => {
    // Zermatt z12: 1.6 crossings per cell at 20 m → 32 m per cell.
    const levels = adaptiveLevels(12, 1.6 * 20);
    expect(levels).toEqual([50, 250]);
    expect((1.6 * 20) / levels[0]).toBeLessThanOrEqual(MAX_CROSSINGS_PER_CELL);
    expect(adaptiveLevels(13, 1.8 * 10)).toEqual([20, 100]);
    // Never past the coarsest step.
    expect(adaptiveLevels(13, 1e6)).toEqual(LEVEL_LADDER[LEVEL_LADDER.length - 1]);
  });

  it('scales region relief to the grid pixel', () => {
    expect(cellReliefAt(80, 8, 10)).toBe(20);
    expect(cellReliefAt(80, 10, 10)).toBe(80);
  });

  it('measures mean relief per pixel, skipping NaN', () => {
    // A ramp climbing 10 m per pixel eastwards: |dx| = 10, |dy| = 0.
    const w = 4;
    const ramp = new Float32Array(16).map((_, i) => (i % w) * 10);
    expect(meanPixelRelief(ramp, w, 4)).toBeCloseTo((2 * (12 * 10)) / 24);
    expect(meanPixelRelief(new Float32Array(16).fill(Number.NaN), 4, 4)).toBe(0);
    expect(meanPixelRelief(new Float32Array(16).fill(500), 4, 4)).toBe(0);
  });

  it('rates a region by its steepest block, so a lake cannot average a massif away', () => {
    // 4 × 4 px in 2 × 2 blocks: flat everywhere but a cliff in the top-right block.
    const w = 4;
    const dem = new Float32Array(16);
    dem[2] = 0;
    dem[3] = 40;
    dem[6] = 0;
    dem[7] = 40;
    const whole = meanPixelRelief(dem, w, 4);
    const steepest = steepestBlockRelief(dem, w, 4, 2);
    // The top-right block alone: |dx| = 40 twice; its window pairs include the
    // step down into the block below (40 → 0) once.
    expect(meanPixelRelief(dem, w, 4, 2, 0, 2, 2)).toBe(steepest);
    expect(steepest).toBeGreaterThan(whole * 2);
    expect(steepestBlockRelief(new Float32Array(16).fill(7), w, 4, 2)).toBe(0);
  });
});

describe('line clean-up', () => {
  it('drops collinear points but keeps corners and endpoints', () => {
    const line = [0, 0, 10, 0.5, 20, 0, 30, 0, 30, 10, 30, 20];
    expect(simplifyLine(line, 1)).toEqual([0, 0, 30, 0, 30, 20]);
    expect(simplifyLine(line, 0)).toEqual(line);
    expect(simplifyLine([0, 0, 5, 5], 4)).toEqual([0, 0, 5, 5]);
  });

  it('keeps a closed ring closed', () => {
    const ring = [0, 0, 100, 0, 100, 50, 100, 100, 0, 100, 0, 0];
    const out = simplifyLine(ring, 4);
    expect(out.slice(0, 2)).toEqual(out.slice(-2));
    expect(out).toEqual([0, 0, 100, 0, 100, 100, 0, 100, 0, 0]);
  });

  it('flags only small closed rings as tiny', () => {
    const small = [0, 0, 10, 0, 10, 10, 0, 0];
    const big = [0, 0, 100, 0, 100, 100, 0, 0];
    const open = [0, 0, 10, 0, 10, 10];
    expect(isTinyRing(small, 48)).toBe(true);
    expect(isTinyRing(big, 48)).toBe(false);
    expect(isTinyRing(open, 48)).toBe(false);
    expect(tinyRingSpan(128)).toBe(48);
  });

  it('simplifies less where the tile is overzoomed', () => {
    expect(simplifyTolerance(12, 13)).toBeGreaterThan(simplifyTolerance(13, 13));
    expect(simplifyTolerance(14, 13)).toBe(simplifyTolerance(13, 13));
  });

  it('cleans isolines: no sea level, no tiny rings, majors tagged', () => {
    const features = cleanIsolines(
      {
        '-10': [[0, 0, 100, 100]],
        '0': [[0, 0, 100, 100]],
        '100': [[0, 0, 50, 0.2, 100, 0]],
        '150': [
          [0, 0, 10, 0, 10, 10, 0, 0],
          [0, 0, 300, 300],
        ],
        '160': [[0, 0, 10, 0, 10, 10, 0, 0]],
      },
      { levels: [50, 100], tolerance: 4, tinySpan: 48 },
    );
    expect(features).toEqual([
      { ele: 100, level: 1, lines: [[0, 0, 100, 0]] },
      { ele: 150, level: 0, lines: [[0, 0, 300, 300]] },
    ]);
  });
});

/** A decoder for exactly what encodeContourMvt writes, to check it round-trips. */
function decodeMvt(buf: Uint8Array) {
  let pos = 0;
  const varint = (): number => {
    let v = 0;
    let shift = 0;
    let b: number;
    do {
      b = buf[pos++]!;
      v += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    return v;
  };
  const unzig = (n: number) => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);
  const fields = (
    end: number,
    cb: (field: number, wire: number, start: number, len: number) => void,
  ) => {
    while (pos < end) {
      const key = varint();
      const field = key >> 3;
      const wire = key & 7;
      if (wire === 0) {
        cb(field, wire, varint(), 0);
      } else if (wire === 2) {
        const len = varint();
        const start = pos;
        cb(field, wire, start, len);
        pos = start + len;
      } else if (wire === 1) {
        cb(field, wire, pos, 8);
        pos += 8;
      } else throw new Error(`wire ${wire}`);
    }
  };
  const layer = {
    name: '',
    extent: 0,
    version: 0,
    keys: [] as string[],
    values: [] as number[],
    features: [] as { tags: number[]; type: number; lines: [number, number][][] }[],
  };
  fields(buf.length, (f, _w, start, len) => {
    if (f !== 3) return;
    pos = start;
    fields(start + len, (lf, lw, ls, ll) => {
      if (lf === 1) layer.name = new TextDecoder().decode(buf.subarray(ls, ls + ll));
      else if (lf === 3) layer.keys.push(new TextDecoder().decode(buf.subarray(ls, ls + ll)));
      else if (lf === 5) layer.extent = ls;
      else if (lf === 15) layer.version = ls;
      else if (lf === 4) {
        pos = ls;
        fields(ls + ll, (vf, vw, vs) => {
          if (vf === 5) layer.values.push(vs);
          else if (vf === 6) layer.values.push(unzig(vs));
          else if (vf === 3 && vw === 1) {
            layer.values.push(new DataView(buf.buffer, buf.byteOffset + vs, 8).getFloat64(0, true));
          }
        });
      } else if (lf === 2 && lw === 2) {
        const feature = { tags: [] as number[], type: 0, lines: [] as [number, number][][] };
        pos = ls;
        fields(ls + ll, (ff, _fw, fs, fl) => {
          if (ff === 3) feature.type = fs;
          else if (ff === 2) {
            pos = fs;
            while (pos < fs + fl) feature.tags.push(varint());
          } else if (ff === 4) {
            pos = fs;
            let x = 0;
            let y = 0;
            while (pos < fs + fl) {
              const cmd = varint();
              const id = cmd & 7;
              const count = cmd >> 3;
              for (let k = 0; k < count; k++) {
                x += unzig(varint());
                y += unzig(varint());
                if (id === 1) feature.lines.push([[x, y]]);
                else feature.lines[feature.lines.length - 1]!.push([x, y]);
              }
            }
          }
        });
        layer.features.push(feature);
      }
    });
  });
  return layer;
}

describe('steepness tags (k, s)', () => {
  /** A straight line along x, `n` vertices one grid cell (32 units) apart. */
  const straight = (n: number) => Array.from({ length: n }, (_, i) => [i * 32, 100]).flat();

  it('classes the old interval density: flat, three steps, cliffs', () => {
    expect(slopeClass(0)).toBe(0);
    expect(slopeClass(Number.NaN)).toBe(0);
    expect(slopeClass(1.49)).toBe(0);
    expect(slopeClass(1.5)).toBe(1);
    expect(slopeClass(2.5)).toBe(2);
    expect(slopeClass(3.5)).toBe(MAX_SLOPE_CLASS);
    expect(slopeClass(40)).toBe(MAX_SLOPE_CLASS);
  });

  it('counts how many zoom-interval lines a kept line stands for', () => {
    expect(coarsening(20, 20)).toBe(1);
    expect(coarsening(50, 20)).toBe(3); // 2.5 rounds up
    expect(coarsening(200, 50)).toBe(4);
    expect(coarsening(10, 20)).toBe(1); // never below 1
  });

  it('cuts a line where its steepness changes, keeping it continuous', () => {
    const line = straight(30);
    // Gentle for x < 320 (vertices 0–9), a cliff beyond: 4 crossings per cell at 20 m.
    const parts = splitBySlope(line, (x) => (x < 320 ? 10 : 80), 20);
    expect(parts.map((p) => p.s)).toEqual([0, MAX_SLOPE_CLASS]);
    // The stretches share the vertex where they meet, and cover the whole line.
    const [a, b] = parts;
    expect(a!.line.slice(-2)).toEqual(b!.line.slice(0, 2));
    expect(a!.line.slice(0, 2)).toEqual(line.slice(0, 2));
    expect(b!.line.slice(-2)).toEqual(line.slice(-2));
    expect(a!.line.length / 2 + b!.line.length / 2 - 1).toBe(30);
  });

  it('folds stretches shorter than the minimum into a neighbour', () => {
    const line = straight(40);
    // A steep zone in a gentle line: the window ramps the class 0 → 1 → 2 → 3
    // and back over a vertex or two each; those blips fold away.
    const parts = splitBySlope(line, (x) => (x >= 15 * 32 && x < 25 * 32 ? 120 : 5), 20);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.length).toBeLessThanOrEqual(3);
    parts.forEach((p, i) => {
      if (i < parts.length - 1) expect(p.line.length / 2 - 1).toBeGreaterThanOrEqual(MIN_SLOPE_RUN);
      if (i > 0) expect(p.line.slice(0, 2)).toEqual(parts[i - 1]!.line.slice(-2));
    });
    expect(parts.some((p) => p.s === MAX_SLOPE_CLASS)).toBe(true);
    // A short gentle start folds into the steep stretch after it.
    const start = splitBySlope(line, (x) => (x < 2 * 32 ? 0 : 80), 20);
    expect(start.map((p) => p.s)).toEqual([MAX_SLOPE_CLASS]);
    expect(MIN_SLOPE_RUN).toBeGreaterThan(2);
  });

  it('tags k = 1, s = 0 where the interval was kept — whatever the slope', () => {
    const features = cleanIsolines(
      { '100': [straight(20)] },
      { levels: [20, 100], tolerance: 1, tinySpan: 48, baseMinor: 20, gradientAt: () => 500 },
    );
    expect(features).toEqual([{ ele: 100, level: 1, k: 1, s: 0, lines: [[0, 100, 608, 100]] }]);
  });

  it('splits a coarsened tile’s lines into features per steepness class', () => {
    const features = cleanIsolines(
      { '150': [straight(30)] },
      {
        levels: [50, 250],
        tolerance: 1,
        tinySpan: 48,
        baseMinor: 20,
        gradientAt: (x) => (x < 320 ? 10 : 80),
      },
    );
    expect(features.map(({ ele, level, k, s }) => ({ ele, level, k, s }))).toEqual([
      { ele: 150, level: 0, k: 3, s: 0 },
      { ele: 150, level: 0, k: 3, s: MAX_SLOPE_CLASS },
    ]);
    // Without a gradient (or a base interval) nothing is tagged or split.
    expect(
      cleanIsolines({ '150': [straight(30)] }, { levels: [50, 250], tolerance: 1, tinySpan: 48 }),
    ).toEqual([{ ele: 150, level: 0, lines: [[0, 100, 928, 100]] }]);
  });

  it('encodes k and s as properties', () => {
    const layer = decodeMvt(
      encodeContourMvt([{ ele: 1250, level: 1, k: 3, s: 2, lines: [[0, 0, 9, 9]] }]),
    );
    const f = layer.features[0]!;
    const props = Object.fromEntries(
      [0, 2, 4, 6].map((i) => [layer.keys[f.tags[i]!], layer.values[f.tags[i + 1]!]]),
    );
    expect(props).toEqual({ ele: 1250, level: 1, k: 3, s: 2 });
  });
});

describe('encodeContourMvt', () => {
  it('round-trips features, properties and rounded coordinates', () => {
    const mvt = encodeContourMvt([
      {
        ele: 1250,
        level: 1,
        lines: [
          [0.4, 0, 100.6, 50, 101.4, 50.2, 4096, 4096],
          [-10, -10, 20, 20],
        ],
      },
      { ele: 1240, level: 0, lines: [[5, 5, 6, 6]] },
    ]);
    const layer = decodeMvt(mvt);
    expect(layer.name).toBe('contours');
    expect(layer.extent).toBe(4096);
    expect(layer.version).toBe(2);
    expect(layer.keys).toEqual(['ele', 'level', 'k', 's']);
    const props = layer.features.map((f) => ({
      [layer.keys[f.tags[0]!]!]: layer.values[f.tags[1]!],
      [layer.keys[f.tags[2]!]!]: layer.values[f.tags[3]!],
    }));
    expect(props).toEqual([
      { ele: 1250, level: 1 },
      { ele: 1240, level: 0 },
    ]);
    expect(layer.features.map((f) => f.type)).toEqual([2, 2]);
    // Rounded, with the duplicate (101, 50) collapsed; negative buffer coordinates kept.
    expect(layer.features[0]!.lines).toEqual([
      [
        [0, 0],
        [101, 50],
        [4096, 4096],
      ],
      [
        [-10, -10],
        [20, 20],
      ],
    ]);
  });

  it('skips lines that round to a single point, and empty features', () => {
    const layer = decodeMvt(
      encodeContourMvt([
        { ele: 10, level: 0, lines: [[1.1, 1.1, 1.2, 1.2]] },
        { ele: 20, level: 0, lines: [[0, 0, 9, 9]] },
      ]),
    );
    expect(layer.features).toHaveLength(1);
  });

  it('encodes negative and fractional values', () => {
    const layer = decodeMvt(
      encodeContourMvt([{ ele: -5, level: 0.5, lines: [[0, 0, 9, 9]] }], { layer: 'x' }),
    );
    expect(layer.name).toBe('x');
    expect(layer.values).toEqual([-5, 0.5]);
  });

  it('writes the same bytes as before its buffers were reused (stored v3 tiles stay valid)', () => {
    // From the encoder as it was when the v3 tiles in R2 were written.
    const golden =
      '1a940178020a08636f6e746f75727312171208000001010202030318022209090000121400c4042712231208' +
      '000401030202030518022215098040804012bf0108c501ca0109eb3cc3410a04041210120400060103180222' +
      '060902020a02021a03656c651a056c6576656c1a016b1a01732202286422022801220228022202280022022878' +
      '220228032209190000000000a05e40288020';
    const bytes = encodeContourMvt([
      {
        ele: 100,
        level: 1,
        k: 2,
        s: 0,
        lines: [
          [0, 0, 10.4, 0.2, 10.4, 0.4, 300, -20],
          [5, 5, 5.2, 5.1],
        ],
      },
      {
        ele: 120,
        level: 0,
        k: 2,
        s: 3,
        lines: [
          [4096, 4096, 4000, 4100, 3900.5, 4200.5],
          [7, 7, 9, 9],
        ],
      },
      { ele: 122.5, level: 0, lines: [[1, 1, 2, 2]] },
    ]);
    expect(Buffer.from(bytes).toString('hex')).toBe(golden);
  });

  it('is a valid empty tile with no features', () => {
    const layer = decodeMvt(encodeContourMvt([]));
    expect(layer.features).toHaveLength(0);
    expect(layer.name).toBe('contours');
  });
});

// --- PNG ---------------------------------------------------------------------

function crcTable(): Uint32Array {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}
const CRC = crcTable();
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  let c = 0xffffffff;
  for (let i = 4; i < 8 + data.length; i++) c = CRC[(c ^ out[i]!) & 0xff]! ^ (c >>> 8);
  view.setUint32(8 + data.length, (c ^ 0xffffffff) >>> 0);
  return out;
}

/** Terrarium bytes for a height (m). */
function rgb(h: number): [number, number, number] {
  const v = h + 32768;
  const r = Math.floor(v / 256);
  const g = Math.floor(v - r * 256);
  const b = Math.round((v - Math.floor(v)) * 256);
  return [r, g, b];
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** A PNG of `heights` with each row using `filters[y % filters.length]`. */
function terrariumPng(
  heights: number[][],
  { filters = [0], alpha = false, idatSplit = false, colorType = alpha ? 6 : 2, depth = 8 } = {},
): Uint8Array {
  const height = heights.length;
  const width = heights[0]!.length;
  const bpp = alpha ? 4 : 3;
  const stride = width * bpp;
  const rows = heights.map((row) =>
    Uint8Array.from(row.flatMap((h) => (alpha ? [...rgb(h), 255] : rgb(h)))),
  );
  const raw = new Uint8Array(height * (stride + 1));
  rows.forEach((row, y) => {
    const f = filters[y % filters.length]!;
    const prior = y > 0 ? rows[y - 1]! : new Uint8Array(stride);
    raw[y * (stride + 1)] = f;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp]! : 0;
      const b = prior[i]!;
      const c = i >= bpp ? prior[i - bpp]! : 0;
      const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][f]!;
      raw[y * (stride + 1) + 1 + i] = (row[i]! - pred + 256) & 255;
    }
  });
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = depth;
  ihdr[9] = colorType;
  const z = new Uint8Array(deflateSync(raw));
  const idats = idatSplit
    ? [chunk('IDAT', z.subarray(0, 7)), chunk('IDAT', z.subarray(7))]
    : [chunk('IDAT', z)];
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('tEXt', new TextEncoder().encode('k\0v')),
    ...idats,
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const HEIGHTS = [
  [0, 12.5, 250, 4478.25, -20],
  [100, 101, 99.5, 3000, 2999],
  [-1.5, 8848, 0.25, 17, 1234.75],
  [5, 5, 5, 6, 7],
];

describe('decodeTerrariumPng', () => {
  it.each([
    ['None', [0]],
    ['Sub', [1]],
    ['Up', [2]],
    ['Average', [3]],
    ['Paeth', [4]],
    ['mixed', [4, 2, 1, 3]],
    ['mixed, first row Up/Avg/Paeth', [3, 4, 2, 0]],
  ])('decodes %s filters exactly', async (_name, filters) => {
    const png = terrariumPng(HEIGHTS, { filters });
    const dem = await decodeTerrariumPng(png, inflate);
    expect(dem.width).toBe(5);
    expect(dem.height).toBe(4);
    expect(Array.from(dem.data)).toEqual(HEIGHTS.flat());
  });

  it('decodes a rough RGB tile of Paeth rows (the unrolled path) exactly', async () => {
    // Northern Québec's tiles: nearly every row Paeth, noisy to the 1/256 m.
    let seed = 7;
    const noise = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const heights = Array.from({ length: 24 }, (_, y) =>
      Array.from(
        { length: 37 },
        (_, x) => Math.round((400 + 80 * Math.sin(x / 5 + y / 7) + noise() * 30) * 256) / 256,
      ),
    );
    for (const filters of [[4], [4, 4, 4, 2, 4, 1]]) {
      const dem = await decodeTerrariumPng(terrariumPng(heights, { filters }), inflate);
      expect(Array.from(dem.data)).toEqual(heights.flat());
    }
  });

  it('handles RGBA and split IDAT chunks', async () => {
    const dem = await decodeTerrariumPng(
      terrariumPng(HEIGHTS, { filters: [4, 1], alpha: true, idatSplit: true }),
      inflate,
    );
    expect(Array.from(dem.data)).toEqual(HEIGHTS.flat());
  });

  it('clamps heights below the floor', async () => {
    const dem = await decodeTerrariumPng(terrariumPng(HEIGHTS), inflate, -1);
    expect(Math.min(...dem.data)).toBe(-1);
    expect(dem.data[3]).toBe(4478.25);
  });

  it('refuses what it does not handle, so the caller can fall back', async () => {
    await expect(decodeTerrariumPng(new Uint8Array(20), inflate)).rejects.toBeInstanceOf(
      UnsupportedPng,
    );
    await expect(
      decodeTerrariumPng(terrariumPng(HEIGHTS, { colorType: 3 }), inflate),
    ).rejects.toBeInstanceOf(UnsupportedPng);
    await expect(
      decodeTerrariumPng(terrariumPng(HEIGHTS, { depth: 16 }), inflate),
    ).rejects.toBeInstanceOf(UnsupportedPng);
  });
});

describe('Lru', () => {
  it('evicts the least recently used entry', () => {
    const lru = new Lru<string, number>(2);
    lru.set('a', 1);
    lru.set('b', 2);
    expect(lru.get('a')).toBe(1); // a is now the most recent
    lru.set('c', 3);
    expect(lru.get('b')).toBeUndefined();
    expect(lru.get('a')).toBe(1);
    expect(lru.get('c')).toBe(3);
    expect(lru.size).toBe(2);
    lru.delete('a');
    expect(lru.size).toBe(1);
    lru.clear();
    expect(lru.size).toBe(0);
  });
});

describe('R2 key', () => {
  it('is versioned by the generator', () => {
    expect(contourR2Key(13, 4270, 2915)).toBe(`contours/${CONTOUR_VERSION}/13/4270/2915.mvt`);
  });
});
