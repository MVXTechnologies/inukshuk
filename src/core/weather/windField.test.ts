import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createWindField,
  encodeWindTexture,
  GUST_RATIO_MAX,
  sampleWind,
  windUV,
} from './windField';
import { parseFloat32Tiff, type WindGrid } from './windTiff';

function grid(partial: Omit<Partial<WindGrid>, 'data'> & { data: number[] }): WindGrid {
  return {
    width: 2,
    height: 2,
    lon0: -72,
    lat0: 48,
    dLon: 1,
    dLat: 1,
    ...partial,
    data: new Float32Array(partial.data),
  };
}

describe('windUV', () => {
  it('derives components with the meteorological "from" convention', () => {
    // North wind (from the north, 0°) blows SOUTH: v negative, u ~0.
    expect(windUV(10, 0).v).toBeCloseTo(-10);
    expect(windUV(10, 0).u).toBeCloseTo(0);
    // East wind (90°) blows WEST: u negative.
    expect(windUV(10, 90).u).toBeCloseTo(-10);
    expect(windUV(10, 90).v).toBeCloseTo(0);
    // South wind (180°) blows NORTH: v positive.
    expect(windUV(10, 180).v).toBeCloseTo(10);
    // West wind (270°) blows EAST: u positive.
    expect(windUV(10, 270).u).toBeCloseTo(10);
  });

  it('scales linearly with speed', () => {
    const a = windUV(5, 225);
    const b = windUV(10, 225);
    expect(b.u).toBeCloseTo(a.u * 2);
    expect(b.v).toBeCloseTo(a.v * 2);
  });
});

describe('createWindField', () => {
  it('builds u/v/speed from matching grids', () => {
    const field = createWindField(
      grid({ data: [10, 10, 10, 10] }),
      grid({ data: [0, 90, 180, 270] }),
      null,
    );
    expect(field).not.toBeNull();
    expect(field?.v[0]).toBeCloseTo(-10);
    expect(field?.u[1]).toBeCloseTo(-10);
    expect(field?.v[2]).toBeCloseTo(10);
    expect(field?.u[3]).toBeCloseTo(10);
    expect(field?.maxSpeed).toBeCloseTo(10);
    expect(field?.lonSpan).toBeCloseTo(2);
    expect(field?.latSpan).toBeCloseTo(2);
    expect(field?.gustRatio).toBeNull();
  });

  it('rejects mismatched speed/direction rasters', () => {
    expect(
      createWindField(grid({ data: [1, 1, 1, 1] }), grid({ lon0: -80, data: [0, 0, 0, 0] }), null),
    ).toBeNull();
    expect(
      createWindField(
        grid({ data: [1, 1, 1, 1] }),
        grid({ width: 4, height: 1, data: [0, 0, 0, 0] }),
        null,
      ),
    ).toBeNull();
  });

  it('keeps a matching gust grid as clamped ratios', () => {
    const field = createWindField(
      grid({ data: [10, 10, 2, 0.1] }),
      grid({ data: [0, 0, 0, 0] }),
      grid({ data: [15, 40, 1, 5] }),
    );
    expect(field?.gustRatio?.[0]).toBeCloseTo(1.5);
    // 40/10 clamps to the max ratio.
    expect(field?.gustRatio?.[1]).toBeCloseTo(GUST_RATIO_MAX);
    // Gust below speed → no boost.
    expect(field?.gustRatio?.[2]).toBeCloseTo(1);
    // Near-calm cell: ratio forced to 1 (noise guard).
    expect(field?.gustRatio?.[3]).toBeCloseTo(1);
  });

  it('drops a mismatched gust grid instead of failing the field', () => {
    const field = createWindField(
      grid({ data: [1, 1, 1, 1] }),
      grid({ data: [0, 0, 0, 0] }),
      grid({ lat0: 50, data: [9, 9, 9, 9] }),
    );
    expect(field).not.toBeNull();
    expect(field?.gustRatio).toBeNull();
  });

  it('zeroes non-finite cells instead of poisoning the field', () => {
    const field = createWindField(
      grid({ data: [NaN, 5, Infinity, -3] }),
      grid({ data: [0, NaN, 90, 90] }),
      null,
    );
    expect(field?.u[0]).toBe(0);
    expect(field?.speed[1]).toBe(0);
    expect(field?.speed[2]).toBe(0);
    expect(field?.speed[3]).toBe(0);
    // maxSpeed floor keeps normalization sane even when everything was junk.
    expect(field?.maxSpeed).toBeGreaterThanOrEqual(1);
  });

  it('combines the live HRDPS fixtures into a plausible Québec field', () => {
    const speed = parseFloat32Tiff(
      new Uint8Array(readFileSync(join(__dirname, '__fixtures__', 'wcs-hrdps-wspd.tif'))),
    );
    const dir = parseFloat32Tiff(
      new Uint8Array(readFileSync(join(__dirname, '__fixtures__', 'wcs-hrdps-wd.tif'))),
    );
    const gust = parseFloat32Tiff(
      new Uint8Array(readFileSync(join(__dirname, '__fixtures__', 'wcs-hrdps-gust.tif'))),
    );
    expect(speed && dir && gust).toBeTruthy();
    const field = createWindField(speed as WindGrid, dir as WindGrid, gust);
    expect(field).not.toBeNull();
    expect(field?.gustRatio).not.toBeNull();
    const sample = sampleWind(field as NonNullable<typeof field>, -71, 47);
    expect(sample).not.toBeNull();
    // |(u,v)| must reconstruct the sampled speed (bilinear of consistent cells).
    const mag = Math.hypot(sample?.u ?? 0, sample?.v ?? 0);
    expect(mag).toBeGreaterThan(0);
    expect(mag).toBeLessThan(40);
    expect(mag).toBeCloseTo(sample?.speed ?? 0, 0);
  });
});

describe('sampleWind', () => {
  const field = createWindField(
    grid({ data: [1, 2, 3, 4] }),
    grid({ data: [270, 270, 270, 270] }),
    null,
  );

  it('returns exact cell values at cell centers', () => {
    // 2×2 grid over lon [−72,−70], lat [46,48]: cell (0,0) center = (−71.5, 47.5).
    const s = sampleWind(field as NonNullable<typeof field>, -71.5, 47.5);
    expect(s?.speed).toBeCloseTo(1);
    expect(s?.u).toBeCloseTo(1); // west wind blows east
  });

  it('interpolates between cells', () => {
    const s = sampleWind(field as NonNullable<typeof field>, -71, 47.5);
    expect(s?.speed).toBeCloseTo(1.5);
  });

  it('returns null outside the grid', () => {
    expect(sampleWind(field as NonNullable<typeof field>, -60, 47)).toBeNull();
    expect(sampleWind(field as NonNullable<typeof field>, -71, 40)).toBeNull();
  });
});

describe('encodeWindTexture', () => {
  it('round-trips u/v through the RGBA encoding within quantization error', () => {
    const field = createWindField(
      grid({ data: [10, 5, 2, 8] }),
      grid({ data: [10, 100, 200, 300] }),
      null,
    );
    const tex = encodeWindTexture(field as NonNullable<typeof field>);
    expect(tex.rgba).toHaveLength(16);
    const range = { u: tex.uMax - tex.uMin, v: tex.vMax - tex.vMin };
    for (let i = 0; i < 4; i++) {
      const u = tex.uMin + ((tex.rgba[i * 4] ?? 0) / 255) * range.u;
      const v = tex.vMin + ((tex.rgba[i * 4 + 1] ?? 0) / 255) * range.v;
      expect(u).toBeCloseTo(field?.u[i] ?? NaN, 1);
      expect(v).toBeCloseTo(field?.v[i] ?? NaN, 1);
      expect(tex.rgba[i * 4 + 3]).toBe(255);
    }
  });

  it('encodes gust ratios into the blue channel (1 → 0, max → 255)', () => {
    const field = createWindField(
      grid({ data: [10, 10, 10, 10] }),
      grid({ data: [0, 0, 0, 0] }),
      grid({ data: [10, 20, 30, 45] }),
    );
    const tex = encodeWindTexture(field as NonNullable<typeof field>);
    expect(tex.rgba[2]).toBe(0);
    expect(tex.rgba[6]).toBeCloseTo(127, -1);
    expect(tex.rgba[10]).toBe(255);
    expect(tex.rgba[14]).toBe(255); // clamped past GUST_RATIO_MAX
  });

  it('survives a dead-calm field without a zero division', () => {
    const field = createWindField(grid({ data: [0, 0, 0, 0] }), grid({ data: [0, 0, 0, 0] }), null);
    const tex = encodeWindTexture(field as NonNullable<typeof field>);
    for (const b of tex.rgba) expect(Number.isFinite(b)).toBe(true);
    expect(tex.uMax).toBeGreaterThan(tex.uMin);
  });
});
