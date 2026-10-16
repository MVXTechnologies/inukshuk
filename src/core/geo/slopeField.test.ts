import { terrariumToMeters } from './terrain';
import {
  ASPECT_SECTORS,
  aspectSector,
  blockMeanDegrees,
  mercatorPixelGroundM,
  mercatorRowLatDeg,
  slopeAspectField,
} from './slopeField';

/**
 * Reference suite for the slope measurement (#722): synthetic DEMs whose
 * slope and aspect are known analytically, laid on the real Web-Mercator
 * pixel grid at several latitudes. Ground positions are computed on the WGS84
 * ellipsoid independently of the code under test (geodetic lat/lng of each
 * pixel centre → local east/north metres), so a wrong pixel size, a spherical
 * shortcut, or an axis/sign mix-up all show up as degrees of error.
 */

const DEG = 180 / Math.PI;
const A = 6378137;
const E2 = 0.00669437999014;
/** Stated tolerance for analytic planes: Horn is exact on a plane. */
const TOL_DEG = 0.02;

/** Global pixel row (256-px tiles) of a latitude at zoom z. */
function latToRow(latDeg: number, z: number): number {
  const phi = latDeg / DEG;
  return ((1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2) * 256 * 2 ** z;
}

/**
 * Local east/north metres of every pixel centre of a w×h window whose row 0 is
 * global row `top` at zoom z, relative to the window centre — via geodetic
 * coordinates and the ellipsoid's radii of curvature (independent of the code).
 */
function groundGrid(w: number, h: number, z: number, top: number) {
  const n = 256 * 2 ** z;
  const lat0 = mercatorRowLatDeg(top + h / 2, z) / DEG;
  const s0 = Math.sin(lat0);
  const M = (A * (1 - E2)) / (1 - E2 * s0 * s0) ** 1.5;
  const E = new Float64Array(w * h);
  const N = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const phi = Math.atan(Math.sinh(Math.PI * (1 - (2 * (top + y + 0.5)) / n)));
    const s = Math.sin(phi);
    const Nr = A / Math.sqrt(1 - E2 * s * s);
    for (let x = 0; x < w; x++) {
      const dLambda = ((x + 0.5 - w / 2) / n) * 2 * Math.PI;
      E[y * w + x] = dLambda * Nr * Math.cos(phi);
      N[y * w + x] = (phi - lat0) * M;
    }
  }
  return { E, N };
}

/** A plane of `slopeDeg` facing compass bearing `aspectDeg` (downhill direction). */
function plane(slopeDeg: number, aspectDeg: number, w: number, h: number, z: number, top: number) {
  const { E, N } = groundGrid(w, h, z, top);
  const t = Math.tan(slopeDeg / DEG);
  const ux = Math.sin(aspectDeg / DEG);
  const uy = Math.cos(aspectDeg / DEG);
  const d = new Float32Array(w * h);
  // Float64 → Float32 loses ~1 mm at 1000 m; keep elevations near 0.
  for (let i = 0; i < d.length; i++) d[i] = -t * (E[i]! * ux + N[i]! * uy);
  return d;
}

const angleDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

describe('Web-Mercator pixel ground size (WGS84)', () => {
  it('is cos(lat)-scaled and conformal on the sphere to 0.4 %', () => {
    for (const lat of [0, 45, 60, 70]) {
      const { ew, ns } = mercatorPixelGroundM(lat, 14);
      const sphere = (2 * Math.PI * A * Math.cos(lat / DEG)) / (256 * 2 ** 14);
      expect(Math.abs(ew / sphere - 1)).toBeLessThan(0.004);
      expect(Math.abs(ns / sphere - 1)).toBeLessThan(0.007);
    }
  });

  it('matches the ellipsoid radii: wider than tall away from the equator', () => {
    // At 45°: N/M ratio = (1 − e² sin²φ)/(1 − e²) → ew/ns ≈ 1.00337.
    const { ew, ns } = mercatorPixelGroundM(45, 14);
    expect(ew / ns).toBeCloseTo((1 - E2 * 0.5) / (1 - E2), 6);
  });

  it('maps rows to latitudes (round trip)', () => {
    for (const lat of [-60, 0, 46.8, 70])
      expect(mercatorRowLatDeg(latToRow(lat, 12), 12)).toBeCloseTo(lat, 9);
  });
});

describe('slopeAspectField — analytic planes', () => {
  const W = 12;
  const H = 12;
  const Z = 14;
  it.each([0, 45, 60, 70])('recovers every slope and aspect at latitude %d°', (lat) => {
    const top = Math.floor(latToRow(lat, Z));
    for (const slopeDeg of [0, 10, 25, 30, 35, 45, 60]) {
      for (const aspectDeg of [0, 30, 45, 90, 135, 180, 225, 270, 315, 359]) {
        const dem = plane(slopeDeg, aspectDeg, W, H, Z, top);
        const { slope, aspect } = slopeAspectField(dem, W, H, Z, top, true);
        // Every pixel, edges included (they use their one-sided span).
        for (let i = 0; i < W * H; i++) {
          expect(Math.abs(slope[i]! - slopeDeg)).toBeLessThan(TOL_DEG);
          if (slopeDeg === 0) expect(aspect![i]).toBeNaN();
          else expect(angleDiff(aspect![i]!, aspectDeg)).toBeLessThan(0.1);
        }
      }
    }
  });

  it('reads edge and corner pixels at full slope (old code halved the outer ring)', () => {
    const top = Math.floor(latToRow(47, Z));
    const dem = plane(33.5, 90, 8, 8, Z, top);
    const { slope } = slopeAspectField(dem, 8, 8, Z, top, false);
    for (const i of [0, 7, 56, 63, 3, 24, 31, 59]) expect(slope[i]).toBeCloseTo(33.5, 1);
  });

  it('skips aspect work unless asked', () => {
    const top = Math.floor(latToRow(47, Z));
    expect(slopeAspectField(plane(30, 0, 4, 4, Z, top), 4, 4, Z, top, false).aspect).toBeNull();
  });

  it('handles a one-pixel-wide or -tall mosaic without dividing by zero', () => {
    const r = slopeAspectField(new Float32Array([1, 2, 3]), 1, 3, Z, 1e6, false);
    for (const v of r.slope) expect(Number.isFinite(v)).toBe(true);
  });

  it('is exact across tile seams of a stitched mosaic (columns 255|256)', () => {
    const top = Math.floor(latToRow(48.9, 13));
    const dem = plane(40, 200, 512, 4, 13, top);
    const { slope } = slopeAspectField(dem, 512, 4, 13, top, false);
    for (const x of [254, 255, 256, 257])
      expect(Math.abs(slope[1 * 512 + x]! - 40)).toBeLessThan(TOL_DEG);
  });
});

describe('slopeAspectField — curved terrain', () => {
  const Z = 15;
  const top = Math.floor(latToRow(47.5, Z));
  const S = 64;

  it('reads a cone at its flank angle everywhere but the apex', () => {
    const { E, N } = groundGrid(S, S, Z, top);
    const dem = new Float32Array(S * S);
    const t = Math.tan(35 / DEG);
    for (let i = 0; i < dem.length; i++) dem[i] = 500 - t * Math.hypot(E[i]!, N[i]!);
    const { slope, aspect } = slopeAspectField(dem, S, S, Z, top, true);
    for (let y = 1; y < S - 1; y++) {
      for (let x = 1; x < S - 1; x++) {
        const i = y * S + x;
        const r = Math.hypot(E[i]!, N[i]!);
        if (r < 4 * 1.0 * 3) continue; // within ~3 px of the apex
        // Curvature of the cone's contours: Horn is within 0.5° here.
        expect(Math.abs(slope[i]! - 35)).toBeLessThan(0.5);
        // Faces away from the summit.
        const outward = (Math.atan2(E[i]!, N[i]!) * DEG + 360) % 360;
        expect(angleDiff(aspect![i]!, outward)).toBeLessThan(2);
      }
    }
  });

  it('keeps a symmetric ridge and valley steep on both sides, softer only at the crease', () => {
    const { E } = groundGrid(S, 8, Z, top);
    const t = Math.tan(38 / DEG);
    const ridge = new Float32Array(S * 8);
    const valley = new Float32Array(S * 8);
    for (let i = 0; i < ridge.length; i++) {
      ridge[i] = -t * Math.abs(E[i]!);
      valley[i] = t * Math.abs(E[i]!);
    }
    for (const dem of [ridge, valley]) {
      const { slope } = slopeAspectField(dem, S, 8, Z, top, false);
      for (let x = 0; x < S; x++) {
        if (Math.abs(x + 0.5 - S / 2) < 1) {
          expect(slope[4 * S + x]!).toBeLessThan(38); // the two crease cells straddle both faces
        } else {
          expect(Math.abs(slope[4 * S + x]! - 38)).toBeLessThan(TOL_DEG);
        }
      }
    }
  });
});

describe('slopeAspectField — no-data and Terrarium decoding', () => {
  const Z = 14;
  const top = Math.floor(latToRow(46.8, Z));

  it('never paints a void as a cliff: neighbours stay exact, the void is NaN', () => {
    const dem = plane(20, 45, 10, 10, Z, top);
    dem[5 * 10 + 5] = terrariumToMeters(0, 0, 0); // −32 768 m: a Terrarium void
    dem[2 * 10 + 7] = NaN;
    const { slope, aspect } = slopeAspectField(dem, 10, 10, Z, top, true);
    expect(slope[55]).toBeNaN();
    expect(aspect![55]).toBeNaN();
    expect(slope[27]).toBeNaN();
    for (let i = 0; i < 100; i++) {
      if (i === 55 || i === 27) continue;
      expect(Math.abs(slope[i]! - 20)).toBeLessThan(TOL_DEG);
    }
  });

  it('falls back to the centre when a void has no opposite neighbour either', () => {
    const dem = new Float32Array(9).fill(100);
    dem[3] = NaN; // west
    dem[5] = NaN; // east
    const { slope } = slopeAspectField(dem, 3, 3, Z, top, false);
    expect(slope[4]).toBe(0);
  });

  it('Terrarium decoding (1/256 m steps) costs < 0.05° on gentle and steep planes', () => {
    for (const deg of [1, 10, 30, 45]) {
      const dem = plane(deg, 120, 16, 16, Z, top);
      const q = new Float32Array(dem.length);
      for (let i = 0; i < dem.length; i++) {
        // Encode exactly as the tile server does, then decode with the app's function.
        const v = Math.round((dem[i]! + 1000 + 32768) * 256);
        q[i] = terrariumToMeters(Math.floor(v / 65536), Math.floor(v / 256) % 256, v % 256);
      }
      const { slope } = slopeAspectField(q, 16, 16, Z, top, false);
      for (const v of slope) expect(Math.abs(v - deg)).toBeLessThan(0.05);
    }
  });
});

describe('aspectSector (#723)', () => {
  it('bins bearings into 8 sectors centred on N, NE … NW', () => {
    expect(ASPECT_SECTORS).toHaveLength(8);
    expect(aspectSector(0)).toBe(0);
    expect(aspectSector(22.49)).toBe(0);
    expect(aspectSector(22.5)).toBe(1);
    expect(aspectSector(359.9)).toBe(0);
    expect(aspectSector(337.5)).toBe(0);
    expect(aspectSector(337.49)).toBe(7);
    for (let s = 0; s < 8; s++) expect(aspectSector(s * 45)).toBe(s);
    expect(aspectSector(NaN)).toBe(-1);
  });

  it('labels the sector of a planar face from the field in one pass', () => {
    const top = Math.floor(latToRow(47, 14));
    for (let s = 0; s < 8; s++) {
      const { aspect } = slopeAspectField(
        plane(30, s * 45 + 10, 4, 4, 14, top),
        4,
        4,
        14,
        top,
        true,
      );
      for (const a of aspect!) expect(ASPECT_SECTORS[aspectSector(a)]).toBe(ASPECT_SECTORS[s]);
    }
  });
});

describe('blockMeanDegrees', () => {
  it('averages degrees per block, ragged edges included, skipping NaN', () => {
    const f = new Float32Array([10, 20, 30, NaN, 30, 40, 50, NaN, 1, 1, NaN, NaN]);
    const r = blockMeanDegrees(f, 4, 3, 2);
    expect([r.width, r.height]).toEqual([2, 2]);
    expect(r.data[0]).toBeCloseTo(25);
    expect(r.data[1]).toBeCloseTo(40);
    expect(r.data[2]).toBeCloseTo(1);
    expect(r.data[3]).toBeNaN();
  });

  it('returns the field itself at step 1 (and below)', () => {
    const f = new Float32Array(4);
    expect(blockMeanDegrees(f, 2, 2, 1).data).toBe(f);
    expect(blockMeanDegrees(f, 2, 2, 0).data).toBe(f);
  });
});
