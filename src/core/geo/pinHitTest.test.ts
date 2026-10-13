/**
 * The pin hit-test (#343).
 *
 * The bug this file exists for: `MapScreen` projected every pin with
 * `Promise.all` and returned on rejection, so ONE stored waypoint the
 * projector refused killed every map tap — silently, and across restarts,
 * because the waypoint is persisted. These cases pin the two properties that
 * prevent it: a bad coordinate never reaches the projector, and a projection
 * that fails anyway costs only that pin.
 */
import { WAYPOINT_PIN_DIAMETER, WAYPOINT_SIZES, pinGeometry } from '@core/library/waypointStyle';

import {
  PIN_HIT_SLOP_PX,
  PIN_MIN_TAP_RADIUS_PX,
  nearestPinAt,
  pinHitArea,
  projectablePins,
  unprojectablePins,
  type ProjectedPin,
} from './pinHitTest';

const pin = (id: string, longitude: number, latitude: number) => ({ id, longitude, latitude });

const GOOD = [pin('a', -71.2, 46.8), pin('b', -71.1, 46.9)];

describe('projectablePins', () => {
  it('keeps real places, with the index they came from', () => {
    expect(projectablePins(GOOD)).toEqual([
      { index: 0, lngLat: [-71.2, 46.8] },
      { index: 1, lngLat: [-71.1, 46.9] },
    ]);
  });

  it.each([
    ['NaN latitude', pin('x', -71, Number.NaN)],
    ['infinite longitude', pin('x', Number.POSITIVE_INFINITY, 46)],
    ['latitude past the pole', pin('x', -71, 91)],
    ['longitude past the antimeridian', pin('x', 181, 46)],
  ])('never asks the projector about a pin with %s', (_label, bad) => {
    expect(projectablePins([bad])).toEqual([]);
    expect(unprojectablePins([bad])).toEqual([bad]);
  });

  it('keeps the good pins in a list that also holds a bad one', () => {
    const pins = [GOOD[0]!, pin('bad', Number.NaN, Number.NaN), GOOD[1]!];
    expect(projectablePins(pins).map((p) => p.index)).toEqual([0, 2]);
    expect(unprojectablePins(pins).map((p) => p.id)).toEqual(['bad']);
  });

  it('accepts the exact edges rather than nudging them away', () => {
    expect(projectablePins([pin('edge', 180, 90), pin('edge2', -180, -90)])).toHaveLength(2);
  });
});

describe('pinHitArea', () => {
  it.each(WAYPOINT_SIZES)('centres size %s on its head, as the symbol pin draws it', (size) => {
    const d = WAYPOINT_PIN_DIAMETER[size];
    for (const gesture of ['tap', 'longPress'] as const) {
      expect(pinHitArea(size, gesture).headOffsetPx).toBeCloseTo(pinGeometry(d).headCenterY, 9);
    }
  });

  it.each(WAYPOINT_SIZES)('gives size %s a finger-sized tap disc around its head', (size) => {
    const d = WAYPOINT_PIN_DIAMETER[size];
    const { radiusPx } = pinHitArea(size, 'tap');
    expect(radiusPx).toBe(Math.max(PIN_MIN_TAP_RADIUS_PX, d / 2 + PIN_HIT_SLOP_PX.tap));
    expect(radiusPx).toBeGreaterThanOrEqual(24); // a 48 dp touch target
  });

  it.each(WAYPOINT_SIZES)('gives size %s a tighter long-press disc than its tap disc', (size) => {
    const d = WAYPOINT_PIN_DIAMETER[size];
    const long = pinHitArea(size, 'longPress').radiusPx;
    expect(long).toBe(d / 2 + PIN_HIT_SLOP_PX.longPress);
    expect(long).toBeLessThan(pinHitArea(size, 'tap').radiusPx);
    // Never smaller than the head itself.
    expect(long).toBeGreaterThan(d / 2);
  });

  it('grows with the pin: S < M < L < XL', () => {
    const r = WAYPOINT_SIZES.map((size) => pinHitArea(size, 'tap'));
    for (let i = 1; i < r.length; i++) {
      expect(r[i]?.radiusPx).toBeGreaterThan(r[i - 1]?.radiusPx ?? Infinity);
      expect(r[i]?.headOffsetPx).toBeGreaterThan(r[i - 1]?.headOffsetPx ?? Infinity);
    }
  });

  it('draws an unsized pin (a live recording pin) as M', () => {
    expect(pinHitArea(undefined, 'tap')).toEqual(pinHitArea('M', 'tap'));
    expect(pinHitArea(undefined, 'longPress')).toEqual(pinHitArea('M', 'longPress'));
  });
});

describe('nearestPinAt', () => {
  const projected = (...points: ProjectedPin[]): ProjectedPin[] => points;
  const M = pinHitArea('M', 'tap');

  it('picks the pin whose head is under the tap, not its tip', () => {
    // Tap on the head of 'a', whose tip (the coordinate) projects to (100, 100).
    const hit = nearestPinAt(
      GOOD,
      projected([100, 100], [400, 400]),
      [100, 100 - M.headOffsetPx],
      'tap',
    );
    expect(hit?.id).toBe('a');
  });

  it.each(WAYPOINT_SIZES)('hits a size %s pin at the edge of its disc, and not past it', (size) => {
    const pins = [{ ...pin('a', -71.2, 46.8), size }];
    for (const gesture of ['tap', 'longPress'] as const) {
      const { radiusPx, headOffsetPx } = pinHitArea(size, gesture);
      const head = 100 - headOffsetPx;
      expect(
        nearestPinAt(pins, projected([100, 100]), [100 + radiusPx - 0.5, head], gesture)?.id,
      ).toBe('a');
      expect(
        nearestPinAt(pins, projected([100, 100]), [100 + radiusPx + 0.5, head], gesture),
      ).toBeNull();
    }
  });

  it('measures each pin from its own head: an XL head is higher than an S head', () => {
    const xl = { ...pin('xl', -71.2, 46.8), size: 'XL' as const };
    const s = { ...pin('s', -71.1, 46.9), size: 'S' as const };
    // Both tips on the same spot: a tap on the XL head picks XL, one on the S head picks S.
    const both = projected([100, 100], [100, 100]);
    const xlHead = 100 - pinHitArea('XL', 'tap').headOffsetPx;
    const sHead = 100 - pinHitArea('S', 'tap').headOffsetPx;
    expect(nearestPinAt([xl, s], both, [100, xlHead], 'tap')?.id).toBe('xl');
    expect(nearestPinAt([xl, s], both, [100, sHead], 'tap')?.id).toBe('s');
  });

  it('keeps a long-press beside a pin for the map (Move only on the pin)', () => {
    const { radiusPx, headOffsetPx } = pinHitArea('M', 'longPress');
    const beside: [number, number] = [100 + radiusPx + 4, 100 - headOffsetPx];
    expect(nearestPinAt(GOOD, projected([100, 100]), beside, 'tap')?.id).toBe('a');
    expect(nearestPinAt(GOOD, projected([100, 100]), beside, 'longPress')).toBeNull();
  });

  it('returns null when the tap is outside every pin', () => {
    expect(nearestPinAt(GOOD, projected([100, 100], [400, 400]), [250, 250], 'tap')).toBeNull();
  });

  // The property the whole fix is about.
  it('still finds a pin when a NEIGHBOUR could not be projected', () => {
    const pins = [pin('unprojectable', -71, 46), GOOD[0]!];
    const hit = nearestPinAt(pins, projected(null, [100, 100]), [100, 100], 'tap');
    expect(hit?.id).toBe('a');
  });

  it('returns null, not a throw, when NOTHING could be projected', () => {
    expect(nearestPinAt(GOOD, projected(null, null), [100, 100], 'tap')).toBeNull();
  });

  it('copes with fewer projections than pins', () => {
    expect(nearestPinAt(GOOD, projected([100, 100]), [100, 100], 'tap')?.id).toBe('a');
  });

  it('opens the pin drawn on top when two sit at the same spot', () => {
    const same = projected([100, 100], [100, 100]);
    const tap: [number, number] = [100, 100 - M.headOffsetPx];
    // Same latitude: the later one draws on top (layer source order).
    const a = pin('a', -71.2, 46.8);
    const b = pin('b', -71.2, 46.8);
    expect(nearestPinAt([a, b], same, tap, 'tap')?.id).toBe('b');
    expect(nearestPinAt([b, a], same, tap, 'tap')?.id).toBe('a');
    // A hair further south draws in front, whatever the list order.
    const south = pin('south', -71.2, 46.79999);
    expect(nearestPinAt([south, a], same, tap, 'tap')?.id).toBe('south');
    expect(nearestPinAt([a, south], same, tap, 'tap')?.id).toBe('south');
  });

  it('prefers the nearer of two pins under the tap', () => {
    const hit = nearestPinAt(GOOD, projected([110, 100], [102, 100]), [100, 100], 'tap');
    expect(hit?.id).toBe('b');
  });
});
