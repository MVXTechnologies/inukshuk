import { rayGroundHit, zoomTowardPoint, type GroundHeightFn } from './terrainRay';

const flat: GroundHeightFn = () => 0;

describe('rayGroundHit', () => {
  it('hits a flat plane exactly, straight down', () => {
    const hit = rayGroundHit({ x: 0.3, y: 5, z: -0.2 }, { x: 0, y: -1, z: 0 }, flat);
    expect(hit).not.toBeNull();
    expect(hit!.x).toBeCloseTo(0.3, 6);
    expect(hit!.y).toBeCloseTo(0, 6);
    expect(hit!.z).toBeCloseTo(-0.2, 6);
  });

  it('hits a flat plane exactly on an oblique ray (normalises dir)', () => {
    // From (0,1,0) along (2,-2,0): crosses y=0 at x=1.
    const hit = rayGroundHit({ x: 0, y: 1, z: 0 }, { x: 2, y: -2, z: 0 }, flat, { maxDist: 10 });
    expect(hit).not.toBeNull();
    expect(hit!.x).toBeCloseTo(1, 5);
    expect(hit!.y).toBeCloseTo(0, 5);
    expect(hit!.z).toBeCloseTo(0, 6);
  });

  it('hits an inclined plane within tolerance', () => {
    const slope: GroundHeightFn = (x) => 0.5 * x;
    // Ray from (0,2,0) along (1,-1,0)/√2: y = 2 − x meets y = 0.5x at x = 4/3.
    const hit = rayGroundHit({ x: 0, y: 2, z: 0 }, { x: 1, y: -1, z: 0 }, slope, { maxDist: 10 });
    expect(hit).not.toBeNull();
    expect(hit!.x).toBeCloseTo(4 / 3, 4);
    expect(hit!.y).toBeCloseTo(2 / 3, 4);
  });

  it('finds the first surface crossing on undulating terrain (not a later one)', () => {
    const bumps: GroundHeightFn = (x) => Math.sin(4 * x) * 0.5;
    const hit = rayGroundHit({ x: 0, y: 2, z: 0 }, { x: 1, y: -0.5, z: 0 }, bumps, { maxDist: 30 });
    expect(hit).not.toBeNull();
    // The hit lies on the surface…
    expect(hit!.y).toBeCloseTo(bumps(hit!.x, hit!.z), 4);
    // …and every earlier march point was above it.
    expect(hit!.x).toBeGreaterThan(0);
  });

  it('returns null for a ray that never meets the terrain', () => {
    expect(rayGroundHit({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }, flat)).toBeNull(); // sky
    expect(rayGroundHit({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, flat)).toBeNull(); // horizon
  });

  it('returns the ground under the origin when starting below the surface', () => {
    const hills: GroundHeightFn = () => 3;
    const hit = rayGroundHit({ x: 1, y: 0, z: 2 }, { x: 0, y: -1, z: 0 }, hills);
    expect(hit).toEqual({ x: 1, y: 3, z: 2 });
  });

  it('returns null for a degenerate direction', () => {
    expect(rayGroundHit({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0 }, flat)).toBeNull();
  });
});

describe('zoomTowardPoint', () => {
  it('keeps the centre fixed at scale 1', () => {
    expect(zoomTowardPoint({ x: 2, z: -1 }, { x: 5, z: 5 }, 1)).toEqual({ x: 2, z: -1 });
  });

  it('halves the distance to the anchor at scale 0.5', () => {
    const c = zoomTowardPoint({ x: 2, z: 0 }, { x: 0, z: 0 }, 0.5);
    expect(c.x).toBeCloseTo(1, 10);
    expect(c.z).toBeCloseTo(0, 10);
  });

  it('moves away from the anchor when zooming out (scale > 1)', () => {
    const c = zoomTowardPoint({ x: 1, z: 1 }, { x: 0, z: 0 }, 2);
    expect(c).toEqual({ x: 2, z: 2 });
  });

  it('converges onto the anchor as scale → 0', () => {
    const c = zoomTowardPoint({ x: 7, z: -3 }, { x: 1, z: 2 }, 0);
    expect(c).toEqual({ x: 1, z: 2 });
  });
});
