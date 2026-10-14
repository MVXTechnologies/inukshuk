import { haversineMeters } from '@core/geo/geomath';
import { largeLibrary } from '@core/heat/__fixtures__/quebecLibrary';
import type { LatLng } from '@core/models';
import { at, noise, offset, polyline } from './__fixtures__/paths';
import {
  trailPathCoordinates,
  nearestOnTrail,
  pointAtAlong,
  prepareTrail,
  projectOnSegment,
  projectionPoint,
  toLocal,
  type PreparedTrail,
  type QueryCost,
} from './trailIndex';

/** The exact nearest distance by brute force over every active segment. */
function bruteNearest(trail: PreparedTrail, p: LatLng): number {
  const { x, y } = toLocal(trail, p);
  let best = Infinity;
  if (trail.n === 1) return projectOnSegment(trail, -1, x, y).distM;
  for (let i = 0; i + 1 < trail.n; i++) {
    if (!trail.segActive[i]) continue;
    best = Math.min(best, projectOnSegment(trail, i, x, y).distM);
  }
  return best;
}

describe('prepareTrail', () => {
  it('returns null for an empty or unusable trail', () => {
    expect(prepareTrail([])).toBeNull();
    expect(prepareTrail([{ latitude: NaN, longitude: 0 }])).toBeNull();
  });

  it('drops consecutive duplicates and measures along with haversine steps', () => {
    const a = at(0, 0);
    const b = at(100, 0);
    const c = at(100, 50);
    const trail = prepareTrail([a, a, b, b, c])!;
    expect(trail.n).toBe(3);
    expect(trail.along[1]).toBeCloseTo(haversineMeters(a, b), 6);
    expect(trail.lengthM).toBeCloseTo(haversineMeters(a, b) + haversineMeters(b, c), 6);
  });

  it('does not walk a pause gap, like interpolateTrackAtDistance', () => {
    const pts = [at(0, 0), at(100, 0), at(100, 500), at(200, 500)];
    const trail = prepareTrail(pts, [2])!;
    expect(trail.segActive[1]).toBe(0);
    expect(trail.edgeLen[1]).toBe(0);
    expect(trail.lengthM).toBeCloseTo(200, 0);
    // A point beside the gap's straight line is NOT on the trail.
    const beside = nearestOnTrail(trail, at(100, 250));
    expect(beside.distM).toBeGreaterThan(200);
  });

  it('remaps the gap when duplicates before it are dropped', () => {
    const pts = [at(0, 0), at(0, 0), at(100, 0), at(100, 500), at(200, 500)];
    const trail = prepareTrail(pts, [3])!;
    expect(trail.n).toBe(4);
    expect(trail.segActive[1]).toBe(0);
  });
});

describe('nearestOnTrail', () => {
  it('is exact: matches brute force around a long Québec activity', () => {
    const lib = largeLibrary(2, { stepSec: 2 });
    const pts = lib.points(1);
    const trail = prepareTrail(pts, lib.segmentStarts(1))!;
    const r = noise(7);
    for (let k = 0; k < 200; k++) {
      const base = pts[(k * 37) % pts.length]!;
      // From on the trail out to 2 km away.
      const spread = k < 100 ? 30 : 2000;
      const q = offset(base, r() * spread, r() * spread);
      const got = nearestOnTrail(trail, q);
      expect(got.distM).toBeCloseTo(bruteNearest(trail, q), 6);
    }
  });

  it('visits a handful of segments near the trail, not the whole trail', () => {
    const lib = largeLibrary(4, { stepSec: 1 });
    const pts = lib.points(3);
    const trail = prepareTrail(pts)!;
    expect(trail.n).toBeGreaterThan(2000);
    const cost: QueryCost = { segments: 0, cells: 0 };
    const queries = 100;
    const r = noise(3);
    for (let k = 0; k < queries; k++) {
      nearestOnTrail(trail, offset(pts[(k * 101) % pts.length]!, r() * 10, r() * 10), { cost });
    }
    // Measured: a few dozen segments per query on a 1 Hz track.
    expect(cost.segments / queries).toBeLessThan(trail.n / 20);
  });

  it('breaks near-ties towards the preferred distance along (out-and-back)', () => {
    // Out 500 m east, back 500 m west, 3 m to the north of the way out.
    const pts = [
      ...polyline([
        [0, 0],
        [500, 0],
      ]),
      ...polyline([
        [500, 3],
        [0, 3],
      ]),
    ];
    const trail = prepareTrail(pts)!;
    const q = at(250, 1.5);
    const out = nearestOnTrail(trail, q, { prefer: 250 });
    const back = nearestOnTrail(trail, q, { prefer: 750 });
    expect(out.alongM).toBeCloseTo(250, 0);
    expect(back.alongM).toBeGreaterThan(700);
    expect(back.alongM).toBeLessThan(800);
  });

  it('handles a one-point trail', () => {
    const trail = prepareTrail([at(0, 0)])!;
    const p = nearestOnTrail(trail, at(30, 40));
    expect(p.distM).toBeCloseTo(50, 0);
    expect(p.alongM).toBe(0);
    expect(projectionPoint(trail, p)).toEqual(at(0, 0));
    expect(pointAtAlong(trail, 10)).toEqual(at(0, 0));
  });

  it('finds the trail from far outside its grid', () => {
    const trail = prepareTrail(
      polyline([
        [0, 0],
        [1000, 0],
      ]),
    )!;
    const p = nearestOnTrail(trail, at(500, 50_000));
    expect(p.distM).toBeCloseTo(50_000, -1);
    expect(p.alongM).toBeCloseTo(500, -1);
  });
});

describe('pointAtAlong', () => {
  const trail = prepareTrail([at(0, 0), at(100, 0), at(100, 100)])!;

  it('clamps to the ends', () => {
    expect(pointAtAlong(trail, -5)).toEqual(at(0, 0));
    expect(pointAtAlong(trail, 1e9)).toEqual(at(100, 100));
  });

  it('interpolates inside a segment', () => {
    const mid = pointAtAlong(trail, trail.along[1]! + 50);
    expect(haversineMeters(mid, at(100, 50))).toBeLessThan(0.5);
  });

  it('jumps across a pause gap to its far side', () => {
    const gapped = prepareTrail([at(0, 0), at(100, 0), at(100, 500), at(200, 500)], [2])!;
    const p = pointAtAlong(gapped, gapped.along[1]! + 10);
    expect(haversineMeters(p, at(110, 500))).toBeLessThan(0.5);
  });

  it('agrees with projectionPoint for a projection', () => {
    const proj = nearestOnTrail(trail, at(40, 20));
    const a = projectionPoint(trail, proj);
    const b = pointAtAlong(trail, proj.alongM);
    expect(haversineMeters(a, b)).toBeLessThan(0.01);
  });
});

describe('trailPathCoordinates', () => {
  it('draws the trail as [lon, lat] lines, split at a pause', () => {
    const pts = [
      { latitude: 46, longitude: -71 },
      { latitude: 46.001, longitude: -71 },
      { latitude: 46.002, longitude: -71 },
      { latitude: 46.003, longitude: -71 },
    ];
    const whole = trailPathCoordinates(prepareTrail(pts)!);
    expect(whole).toEqual([
      [
        [-71, 46],
        [-71, 46.001],
        [-71, 46.002],
        [-71, 46.003],
      ],
    ]);
    const paused = trailPathCoordinates(prepareTrail(pts, [2])!);
    expect(paused).toEqual([
      [
        [-71, 46],
        [-71, 46.001],
      ],
      [
        [-71, 46.002],
        [-71, 46.003],
      ],
    ]);
  });

  it('draws nothing for a one-point trail', () => {
    expect(trailPathCoordinates(prepareTrail([{ latitude: 46, longitude: -71 }])!)).toEqual([]);
  });
});
