import {
  bearingDeg,
  circleRing,
  destination,
  extentM,
  haversineM,
  lengthM,
  metresPerDp,
  simplify,
  unwrapLng,
  type Pt,
} from './geo';
import { QC } from './testUtils';

describe('drawing geometry', () => {
  it('unwraps longitudes around a reference', () => {
    expect(unwrapLng(-179, 179)).toBe(181);
    expect(unwrapLng(179, -179)).toBe(-181);
    expect(unwrapLng(10, 0)).toBe(10);
  });

  it('measures a bounding-box diagonal, across the antimeridian too', () => {
    expect(extentM([])).toBe(0);
    expect(extentM([QC])).toBe(0);
    const east = destination(QC, 90, 1000);
    expect(extentM([QC, east])).toBeCloseTo(1000, 0);
    expect(
      extentM([
        [179.995, 0],
        [-179.995, 0],
      ]),
    ).toBeLessThan(1200);
  });

  it('bearing and destination agree', () => {
    for (const deg of [0, 45, 90, 180, 270, 359]) {
      const p = destination(QC, deg, 2000);
      expect(haversineM(QC, p)).toBeCloseTo(2000, 3);
      expect(bearingDeg(QC, p)).toBeCloseTo(deg, 3);
    }
    // Wraps past the antimeridian.
    expect(destination([179.999, 0], 90, 1000)[0]).toBeLessThan(-179);
  });

  it('makes a closed ring of 64 sides at the radius', () => {
    const ring = circleRing(QC, 85.2);
    expect(ring).toHaveLength(65);
    expect(ring[0]).toEqual(ring[64]);
    for (const p of ring) expect(haversineM(QC, p)).toBeCloseTo(85.2, 3);
    expect(circleRing(QC, 10, 8)).toHaveLength(9);
  });

  it('measures a line', () => {
    const a = destination(QC, 0, 100);
    const b = destination(a, 90, 100);
    expect(lengthM([QC, a, b])).toBeCloseTo(200, 1);
    expect(lengthM([QC])).toBe(0);
  });

  it('simplifies with a tolerance in metres, keeping the ends and the corners', () => {
    // A straight line with jitter well under the tolerance, then a corner.
    const pts: Pt[] = [];
    for (let i = 0; i <= 100; i++) {
      const p = destination(QC, 90, i * 10);
      pts.push(destination(p, 0, i % 2 === 0 ? 0.2 : -0.2));
    }
    const corner = destination(pts[100]!, 0, 500);
    const all = [...pts, corner];
    const out = simplify(all, 2);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual(all[0]);
    expect(out[2]).toEqual(corner);
    // A tolerance smaller than the jitter keeps more.
    expect(simplify(all, 0.1).length).toBeGreaterThan(3);
    // Nothing to do, or no tolerance: a copy.
    expect(simplify([QC, corner], 2)).toEqual([QC, corner]);
    expect(simplify(all, 0)).toHaveLength(all.length);
    expect(simplify(all, Number.NaN)).toHaveLength(all.length);
    // A closed loop (first = last) still keeps its far side.
    const loop: Pt[] = [QC, destination(QC, 0, 100), destination(QC, 45, 100), QC];
    expect(simplify(loop, 1)).toHaveLength(4);
  });

  it('gives the metres per dp at a zoom', () => {
    expect(metresPerDp(0, 0)).toBeCloseTo(78271.52, 1);
    expect(metresPerDp(16, 60)).toBeCloseTo(78271.51696 / 2 / 65536, 6);
  });
});

describe('circleRing with no sides', () => {
  it('is empty (no closing point to copy)', () => {
    expect(circleRing([0, 0], 10, 0)).toEqual([]);
  });
});
