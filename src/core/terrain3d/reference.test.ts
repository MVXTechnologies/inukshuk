import { centerPx, eyeFromProjection, projectionMatrix } from './camera';
import { referenceHeight, referencePoints, REFERENCE_NDC, smoothToward } from './reference';
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
