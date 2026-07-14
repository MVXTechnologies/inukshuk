import { coneHalfAngleDeg, headingConeFeature } from './headingCone';

const DEG2RAD = Math.PI / 180;
const M_PER_DEG_LAT = 111_320;

/** Planar distance (m) from `center` to a [lng, lat] ring vertex. */
function planarDistanceM(
  center: { latitude: number; longitude: number },
  [lng, lat]: [number, number],
): number {
  const dNorth = (lat - center.latitude) * M_PER_DEG_LAT;
  const dEast = (lng - center.longitude) * M_PER_DEG_LAT * Math.cos(center.latitude * DEG2RAD);
  return Math.hypot(dNorth, dEast);
}

/** Bearing (deg, clockwise from north, [0,360)) from `center` to a vertex. */
function bearingDeg(
  center: { latitude: number; longitude: number },
  [lng, lat]: [number, number],
): number {
  const dNorth = (lat - center.latitude) * M_PER_DEG_LAT;
  const dEast = (lng - center.longitude) * M_PER_DEG_LAT * Math.cos(center.latitude * DEG2RAD);
  return (Math.atan2(dEast, dNorth) / DEG2RAD + 360) % 360;
}

const center = { latitude: 46.8, longitude: -71.2 }; // Québec-ish

describe('coneHalfAngleDeg', () => {
  it('widens as calibration degrades', () => {
    expect(coneHalfAngleDeg(3)).toBeLessThan(coneHalfAngleDeg(2));
    expect(coneHalfAngleDeg(2)).toBeLessThan(coneHalfAngleDeg(1));
    expect(coneHalfAngleDeg(1)).toBeLessThan(coneHalfAngleDeg(0));
  });

  it('uses a middle-of-the-road width when accuracy is unknown', () => {
    expect(coneHalfAngleDeg(null)).toBe(40);
    expect(coneHalfAngleDeg(undefined)).toBe(40);
    expect(coneHalfAngleDeg(Number.NaN)).toBe(40);
  });

  it('clamps out-of-range and rounds fractional levels', () => {
    expect(coneHalfAngleDeg(-2)).toBe(coneHalfAngleDeg(0));
    expect(coneHalfAngleDeg(7)).toBe(coneHalfAngleDeg(3));
    expect(coneHalfAngleDeg(2.6)).toBe(coneHalfAngleDeg(3));
  });
});

describe('headingConeFeature', () => {
  it('builds a closed polygon ring with apex + arc vertices', () => {
    const f = headingConeFeature({
      center,
      headingDeg: 0,
      halfAngleDeg: 30,
      radiusM: 100,
      steps: 24,
    });
    expect(f.type).toBe('Feature');
    expect(f.geometry.type).toBe('Polygon');
    const ring = f.geometry.coordinates[0]!;
    // apex + (steps + 1) arc points + closing apex
    expect(ring).toHaveLength(24 + 3);
    expect(ring[0]).toEqual([center.longitude, center.latitude]);
    expect(ring[ring.length - 1]).toEqual(ring[0]);
  });

  it('places every arc vertex at the requested radius', () => {
    const f = headingConeFeature({ center, headingDeg: 137, halfAngleDeg: 25, radiusM: 80 });
    const ring = f.geometry.coordinates[0]!;
    for (const v of ring.slice(1, -1)) {
      expect(planarDistanceM(center, v as [number, number])).toBeCloseTo(80, 0);
    }
  });

  it('sweeps symmetrically about the heading', () => {
    const f = headingConeFeature({
      center,
      headingDeg: 90,
      halfAngleDeg: 30,
      radiusM: 100,
      steps: 10,
    });
    const ring = f.geometry.coordinates[0]!;
    const first = ring[1]! as [number, number];
    const middle = ring[1 + 5]! as [number, number];
    const last = ring[ring.length - 2]! as [number, number];
    expect(bearingDeg(center, first)).toBeCloseTo(60, 1);
    expect(bearingDeg(center, middle)).toBeCloseTo(90, 1);
    expect(bearingDeg(center, last)).toBeCloseTo(120, 1);
  });

  it('handles the 0/360 wraparound (heading 350, half-angle 30 spans 320→20)', () => {
    const f = headingConeFeature({
      center,
      headingDeg: 350,
      halfAngleDeg: 30,
      radiusM: 100,
      steps: 6,
    });
    const ring = f.geometry.coordinates[0]!;
    const first = ring[1]! as [number, number];
    const middle = ring[1 + 3]! as [number, number];
    const last = ring[ring.length - 2]! as [number, number];
    expect(bearingDeg(center, first)).toBeCloseTo(320, 1);
    expect(bearingDeg(center, middle)).toBeCloseTo(350, 1);
    expect(bearingDeg(center, last)).toBeCloseTo(20, 1);
  });

  it('accepts negative and >360 headings (equivalent mod 360)', () => {
    const a = headingConeFeature({ center, headingDeg: -10, halfAngleDeg: 20, radiusM: 50 });
    const b = headingConeFeature({ center, headingDeg: 350, halfAngleDeg: 20, radiusM: 50 });
    const c = headingConeFeature({ center, headingDeg: 710, halfAngleDeg: 20, radiusM: 50 });
    const ringA = a.geometry.coordinates[0]!;
    const ringB = b.geometry.coordinates[0]!;
    const ringC = c.geometry.coordinates[0]!;
    expect(ringA).toHaveLength(ringB.length);
    ringA.forEach((v, i) => {
      expect(v[0]!).toBeCloseTo(ringB[i]![0]!, 10);
      expect(v[1]!).toBeCloseTo(ringB[i]![1]!, 10);
      expect(v[0]!).toBeCloseTo(ringC[i]![0]!, 10);
      expect(v[1]!).toBeCloseTo(ringC[i]![1]!, 10);
    });
  });

  it('a wider half-angle produces a wider sector', () => {
    const span = (halfAngleDeg: number) => {
      const f = headingConeFeature({ center, headingDeg: 0, halfAngleDeg, radiusM: 100 });
      const ring = f.geometry.coordinates[0]!;
      const first = ring[1]! as [number, number];
      const last = ring[ring.length - 2]! as [number, number];
      const d = Math.abs(bearingDeg(center, first) - bearingDeg(center, last)) % 360;
      return d > 180 ? 360 - d : d;
    };
    expect(span(25)).toBeCloseTo(50, 1);
    expect(span(55)).toBeCloseTo(110, 1);
    expect(span(55)).toBeGreaterThan(span(25));
  });

  it('stretches longitude at high latitude (same ground size)', () => {
    const north = { latitude: 60, longitude: 10 };
    const equator = { latitude: 0, longitude: 10 };
    const f60 = headingConeFeature({
      center: north,
      headingDeg: 90,
      halfAngleDeg: 1,
      radiusM: 100,
      steps: 2,
    });
    const f0 = headingConeFeature({
      center: equator,
      headingDeg: 90,
      halfAngleDeg: 1,
      radiusM: 100,
      steps: 2,
    });
    const tip60 = f60.geometry.coordinates[0]![2]! as [number, number];
    const tip0 = f0.geometry.coordinates[0]![2]! as [number, number];
    const dLng60 = tip60[0] - north.longitude;
    const dLng0 = tip0[0] - equator.longitude;
    expect(dLng60 / dLng0).toBeCloseTo(1 / Math.cos(60 * DEG2RAD), 2);
  });

  it('clamps latitude near the poles instead of blowing up', () => {
    const f = headingConeFeature({
      center: { latitude: 89.9, longitude: 0 },
      headingDeg: 0,
      halfAngleDeg: 30,
      radiusM: 100,
    });
    for (const [lng, lat] of f.geometry.coordinates[0]!) {
      expect(Number.isFinite(lng!)).toBe(true);
      expect(Number.isFinite(lat!)).toBe(true);
    }
  });

  it('rejects invalid options', () => {
    expect(() =>
      headingConeFeature({ center, headingDeg: Number.NaN, halfAngleDeg: 30, radiusM: 100 }),
    ).toThrow();
    expect(() =>
      headingConeFeature({ center, headingDeg: 0, halfAngleDeg: 0, radiusM: 100 }),
    ).toThrow();
    expect(() =>
      headingConeFeature({ center, headingDeg: 0, halfAngleDeg: 91, radiusM: 100 }),
    ).toThrow();
    expect(() =>
      headingConeFeature({ center, headingDeg: 0, halfAngleDeg: 30, radiusM: 0 }),
    ).toThrow();
    expect(() =>
      headingConeFeature({ center, headingDeg: 0, halfAngleDeg: 30, radiusM: 100, steps: 1 }),
    ).toThrow();
    expect(() =>
      headingConeFeature({ center, headingDeg: 0, halfAngleDeg: 30, radiusM: 100, steps: 2.5 }),
    ).toThrow();
  });
});
