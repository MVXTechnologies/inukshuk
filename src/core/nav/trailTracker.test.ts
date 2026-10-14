import { largeLibrary } from '@core/heat/__fixtures__/quebecLibrary';
import { at, noise, offset, polyline, switchbacks } from './__fixtures__/paths';
import { pointAtAlong, prepareTrail } from './trailIndex';
import { createTrailTracker } from './trailTracker';

describe('createTrailTracker', () => {
  it('searches the whole trail only on the first fix while on it', () => {
    const pts = polyline(
      [
        [0, 0],
        [2000, 0],
      ],
      2,
    );
    const tracker = createTrailTracker(prepareTrail(pts)!);
    const first = tracker.update(pts[0]!);
    expect(first.cost.global).toBe(true);
    for (let i = 1; i < pts.length; i += 3) {
      const fix = tracker.update(pts[i]!);
      expect(fix.cost.global).toBe(false);
    }
  });

  it('never jumps to the next switchback leg on noisy fixes', () => {
    // Legs 150 m long, 15 m apart: the next leg is closer than GPS noise reaches.
    const pts = switchbacks(6, 150, 15, 3);
    const trail = prepareTrail(pts)!;
    const tracker = createTrailTracker(trail);
    const r = noise(11);
    let prev = -Infinity;
    // Walk the trail at ~1.5 m per fix with ±4 m noise.
    for (let along = 0; along <= trail.lengthM; along += 1.5) {
      const truth = pointAtAlong(trail, along);
      const fix = tracker.update(offset(truth, r() * 4, r() * 4));
      // Within GPS noise of the truth along the trail, never a leg away.
      expect(Math.abs(fix.alongM - along)).toBeLessThan(20);
      // And never backwards by more than the noise.
      expect(fix.alongM).toBeGreaterThan(prev - 12);
      prev = Math.max(prev, fix.alongM);
    }
  });

  it('keeps an out-and-back on the leg you are walking', () => {
    const lib = largeLibrary(10, { stepSec: 1 });
    // Index 9 rides a long corridor out and back (every fifth activity).
    const pts = lib.points(9);
    const trail = prepareTrail(pts)!;
    const tracker = createTrailTracker(trail);
    let maxJump = 0;
    let last = 0;
    let globals = 0;
    let windowSegs = 0;
    for (let i = 0; i < pts.length; i += 3) {
      const fix = tracker.update(pts[i]!);
      if (i > 0) maxJump = Math.max(maxJump, Math.abs(fix.alongM - last));
      last = fix.alongM;
      if (fix.cost.global) globals++;
      windowSegs = Math.max(windowSegs, fix.cost.windowSegments);
    }
    // Three seconds of riding per fix: never more than that (plus noise) along.
    expect(maxJump).toBeLessThan(60);
    // The way back stays on the way back: along ends near the total length.
    expect(last).toBeGreaterThan(trail.lengthM * 0.95);
    expect(globals).toBe(1);
    // Window cost is independent of the trail's length (measured 32 at most).
    expect(windowSegs).toBeLessThan(200);
    expect(trail.n).toBeGreaterThan(2000);
  });

  it('falls back to the whole trail when you leave it', () => {
    const pts = polyline(
      [
        [0, 0],
        [1000, 0],
        [1000, 1000],
      ],
      5,
    );
    const tracker = createTrailTracker(prepareTrail(pts)!);
    tracker.update(at(100, 0));
    const away = tracker.update(at(100, 200));
    expect(away.cost.global).toBe(true);
    expect(away.distM).toBeCloseTo(200, 0);
    expect(away.alongM).toBeCloseTo(100, -1);
  });

  it('follows a GPS jump to another part of the trail', () => {
    const pts = polyline(
      [
        [0, 0],
        [1000, 0],
        [1000, 1000],
      ],
      5,
    );
    const tracker = createTrailTracker(prepareTrail(pts)!);
    tracker.update(at(100, 0));
    const jumped = tracker.update(at(1005, 600));
    expect(jumped.alongM).toBeGreaterThan(1500);
    expect(jumped.distM).toBeLessThan(6);
  });

  it('throttles whole-trail searches while far from the trail', () => {
    const pts = polyline(
      [
        [0, 0],
        [3000, 0],
      ],
      2,
    );
    const tracker = createTrailTracker(prepareTrail(pts)!);
    let globals = 0;
    // Walk parallel to the trail 2 km north, 1 m per fix for 1 km.
    for (let x = 0; x <= 1000; x += 1) {
      const fix = tracker.update(at(x, 2000));
      if (fix.cost.global) globals++;
      expect(fix.distM).toBeGreaterThan(1990);
      expect(fix.distM).toBeLessThan(2100);
    }
    // One search per ~200 m walked (a tenth of the distance), not per fix.
    expect(globals).toBeLessThanOrEqual(7);
  });

  it('reset forgets the last position', () => {
    const pts = polyline(
      [
        [0, 0],
        [500, 0],
      ],
      5,
    );
    const tracker = createTrailTracker(prepareTrail(pts)!);
    tracker.update(at(10, 0));
    tracker.reset();
    expect(tracker.update(at(400, 0)).cost.global).toBe(true);
  });

  it('caps the window on a pathologically dense trail', () => {
    const pts = polyline(
      [
        [0, 0],
        [100, 0],
      ],
      0.01,
    );
    const tracker = createTrailTracker(prepareTrail(pts)!, { maxWindowSegments: 300 });
    tracker.update(at(50, 0));
    const fix = tracker.update(at(50.5, 0));
    expect(fix.cost.windowSegments).toBeLessThanOrEqual(300);
    expect(fix.distM).toBeLessThan(0.1);
  });

  it('follows a one-point trail', () => {
    const tracker = createTrailTracker(prepareTrail([at(0, 0)])!);
    tracker.update(at(5, 0));
    const fix = tracker.update(at(6, 0));
    expect(fix.distM).toBeCloseTo(6, 0);
    expect(fix.alongM).toBe(0);
  });
});
