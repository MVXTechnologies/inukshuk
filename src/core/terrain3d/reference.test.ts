import { centerPx, eyeFromProjection, projectionMatrix } from './camera';
import {
  referenceHeight,
  referencePoints,
  REFERENCE_NDC,
  smoothToward,
  stableReferenceHeight,
  baseRing,
  baseRingZoom,
} from './reference';
import { camera, PLACES } from './testUtils';

describe('referenceHeight', () => {
  it.each([
    [[100, 300, 200], 300],
    [[null, 50, undefined], 50],
    [[NaN, Infinity, -5], -5],
    [[], 0],
    [[null, null], 0],
  ])('%j → %p', (s, h) => {
    expect(referenceHeight(s as (number | null)[])).toBe(h);
  });
});

describe('referencePoints', () => {
  it.each([0, 30, 60, 80])(
    'pitch %p: the bottom samples lie on the camera side of the centre',
    (p) => {
      const b = 40;
      const c = camera(PLACES.chamonix, p, b);
      const P = projectionMatrix(c);
      const pts = referencePoints(P);
      expect(pts).toHaveLength(REFERENCE_NDC.length);
      const eye = eyeFromProjection(P)!;
      const [cx, cy] = centerPx(c);
      const fx = Math.sin((b * Math.PI) / 180);
      const fy = -Math.cos((b * Math.PI) / 180);
      const dCentre = Math.hypot(cx - eye[0], cy - eye[1]);
      for (const q of pts) {
        expect(q).not.toBeNull();
        expect((q![0] - cx) * fx + (q![1] - cy) * fy).toBeLessThan(0);
        if (p > 0) {
          expect((q![0] - eye[0]) * fx + (q![1] - eye[1]) * fy).toBeLessThan(dCentre);
        }
      }
    },
  );

  it('a singular matrix yields no points', () => {
    expect(referencePoints(new Array<number>(16).fill(0))).toEqual(REFERENCE_NDC.map(() => null));
  });
});

describe('smoothToward', () => {
  it('snaps on the first sample', () => {
    expect(smoothToward(null, 1200, 16)).toBe(1200);
    expect(smoothToward(NaN, 5, 16)).toBe(5);
  });
  it('holds on a zero or bad dt', () => {
    expect(smoothToward(100, 200, 0)).toBe(100);
    expect(smoothToward(100, 200, NaN)).toBe(100);
  });
  it('converges, monotonically, in a few time constants', () => {
    let h = 0;
    let prev = 0;
    for (let i = 0; i < 120; i++) {
      h = smoothToward(h, 1000, 16.7, 150);
      expect(h).toBeGreaterThanOrEqual(prev);
      prev = h;
    }
    expect(h).toBe(1000);
  });
  it('is frame-rate independent', () => {
    let a = 0;
    for (let i = 0; i < 6; i++) a = smoothToward(a, 1000, 16.6667, 150, 0);
    let b = 0;
    for (let i = 0; i < 3; i++) b = smoothToward(b, 1000, 33.3333, 150, 0);
    expect(a).toBeCloseTo(b, 2);
  });
});

describe('stableReferenceHeight', () => {
  const base = { center: 1500, nearMax: 2100, eyeAltM: 6000, heightScale: 1 };
  it('anchors to the ground under the centre', () => {
    expect(stableReferenceHeight(base)).toBe(1500);
  });
  it('ignores the bottom edge while the camera clears it (tilting cannot move it)', () => {
    for (const nearMax of [800, 1500, 2100, 4000]) {
      expect(stableReferenceHeight({ ...base, nearMax })).toBe(1500);
    }
  });
  it('rises only when the near terrain would come too close to the camera', () => {
    // near 4000 m, eye 2000 m above the plane: keep 15 % (300 m) clearance.
    const r = stableReferenceHeight({ ...base, nearMax: 4000, eyeAltM: 2000 });
    expect(r).toBeCloseTo(4000 - (2000 - 300), 6);
    expect((4000 - r) * 1).toBeLessThanOrEqual(2000 - 300 + 1e-9);
  });
  it('accounts for the exaggeration', () => {
    const r = stableReferenceHeight({ ...base, nearMax: 3000, eyeAltM: 2000, heightScale: 2 });
    expect((3000 - r) * 2).toBeCloseTo(2000 - 300, 6);
  });
  it('falls back to the near ground, then 0, and ignores a flat (unramped) scene', () => {
    expect(stableReferenceHeight({ ...base, center: null })).toBe(2100);
    expect(stableReferenceHeight({ ...base, center: null, nearMax: null })).toBe(0);
    expect(stableReferenceHeight({ ...base, nearMax: 9000, heightScale: 0 })).toBe(1500);
    expect(stableReferenceHeight({ ...base, center: Number.NaN })).toBe(2100);
  });
});

describe('baseRing / baseRingZoom (C++ twin: terrain_core.cpp)', () => {
  it('surrounds the point with 25 tiles', () => {
    expect(baseRing(0.5, 0.5, 6)).toHaveLength(25);
  });
  it('wraps across the antimeridian and clamps at the poles', () => {
    const w = baseRing(0.001, 0.5, 4);
    expect(w).toHaveLength(25);
    expect(w.filter((t) => t.wrap === -1)).toHaveLength(10);
    expect(baseRing(0.5, 0.0001, 5)).toHaveLength(15);
  });
  it('picks tiles about half the fog distance wide, within zoom − 7 … zoom − 2', () => {
    expect(baseRingZoom(13, 15600)).toBe(9);
    expect(baseRingZoom(13, 100)).toBe(11);
    expect(baseRingZoom(13, 1e9)).toBe(6);
  });
});
