/**
 * Regression: the point chip ("bubble") went dead after dropping a waypoint
 * (owner report 2026-09-28 — "the bubble just stays open but isn't
 * clickable", and no later tap near it brought up a working one).
 *
 * The sequence: tap the map → chip; tap its Waypoint button → editor → Done.
 * The new pin is planted on the chip's own coordinate, and the chip stayed
 * up on top of it. MapScreen's onMapPress then asked the pins BEFORE the
 * chip, and the pin's 60 px hit disc covers the whole bubble — so Copy,
 * Navigate and Waypoint all toggled the pin's viewer instead. The same
 * happened to any chip dropped next to an existing pin.
 *
 * MapScreen itself is not renderable under jest (MapLibre, GL, the whole
 * app), so this drives onMapPress's decision chain — the REAL chip and pin
 * hit-tests and the REAL routing — through a tiny model of the screen state,
 * in screen px (the projection is the identity here).
 */
import { nearestPinAt, WAYPOINT_PIN_HIT } from '@core/geo/pinHitTest';
import { chipSurvivesHit, pointChipAfterBareTap, routeMapTap } from '@core/map/mapTap';

import { MAP_POINT_ACTION_LAYOUT, hitMapPointChip } from './components/MapPointChip';

type Px = readonly [number, number];

interface Pin {
  id: string;
  longitude: number;
  latitude: number;
}

class MapModel {
  chip: Px | null = null;
  pins: Pin[] = [];
  viewer: string | null = null;
  composing: Px | null = null;
  navigatingTo: Px | null = null;
  copies = 0;

  /** onMapPress, minus the async projection plumbing. */
  tap(at: Px): void {
    const chip = this.chip;
    const chipHit = chip ? hitMapPointChip(at[0] - chip[0], at[1] - chip[1]) : null;
    const pin = nearestPinAt(
      this.pins,
      this.pins.map((p) => [p.longitude, p.latitude] as const),
      at,
      WAYPOINT_PIN_HIT.radiusPx,
      WAYPOINT_PIN_HIT.badgeOffsetPx,
    );
    const route = routeMapTap(chipHit, pin);
    if (route.kind === 'chip' && chip) {
      // runPointChipHit
      if (!chipSurvivesHit(route.hit)) this.chip = null;
      if (route.hit === 'waypoint') this.composing = chip;
      else if (route.hit === 'navigate') this.navigatingTo = chip;
      else {
        this.copies += 1;
        this.viewer = null;
      }
      return;
    }
    if (route.kind === 'pin') {
      this.viewer = this.viewer === route.pin.id ? null : route.pin.id;
      return;
    }
    this.chip = pointChipAfterBareTap(this.chip, at);
    this.viewer = null;
  }

  /** The editor's Done: the composed waypoint becomes a pin. */
  done(): void {
    const at = this.composing;
    if (!at) throw new Error('no waypoint being composed');
    this.pins.push({ id: `wp-${this.pins.length + 1}`, longitude: at[0], latitude: at[1] });
    this.composing = null;
  }
}

// Where each part of the chip sits relative to its coordinate.
const { buttonWidth, buttonHeight, gap, bottomOffset } = MAP_POINT_ACTION_LAYOUT;
const ROW_Y = -(bottomOffset + buttonHeight / 2);
// The row's three buttons are centred on the point: Navigate, Waypoint, Convert.
const onNavigate = (c: Px): Px => [c[0] - (gap + buttonWidth), c[1] + ROW_Y];
const onWaypoint = (c: Px): Px => [c[0], c[1] + ROW_Y];
// The readout lines sit just above the action row.
const onReadout = (c: Px): Px => [c[0], c[1] - (bottomOffset + buttonHeight + 6)];

const A: Px = [200, 400];

describe('the point chip around waypoints', () => {
  it('shows, adds a waypoint, closes — and works again, twice over', () => {
    const map = new MapModel();

    map.tap(A);
    expect(map.chip).toEqual(A);

    map.tap(onWaypoint(A));
    expect(map.composing).toEqual(A);
    // The chip does not linger on top of the pin that is about to exist.
    expect(map.chip).toBeNull();
    map.done();
    expect(map.pins).toHaveLength(1);

    // A tap well clear of the pin brings back a working chip…
    const B: Px = [60, 650];
    map.tap(B);
    expect(map.chip).toEqual(B);
    expect(map.viewer).toBeNull();

    // …whose Add waypoint works a second time.
    map.tap(onWaypoint(B));
    expect(map.composing).toEqual(B);
    map.done();
    expect(map.pins).toHaveLength(2);
  });

  // The stale bubble itself: a chip open over a pin (Go to coordinates' "Go"
  // re-drops it anywhere, and before the fix Add waypoint left it there).
  it('keeps every part of a chip open over its own pin clickable', () => {
    const setup = () => {
      const map = new MapModel();
      map.pins.push({ id: 'wp-1', longitude: A[0], latitude: A[1] });
      map.chip = A;
      return map;
    };

    let map = setup();
    map.tap(onWaypoint(A));
    expect(map.composing).toEqual(A);
    expect(map.viewer).toBeNull();

    map = setup();
    map.tap(onNavigate(A));
    expect(map.navigatingTo).toEqual(A);
    expect(map.viewer).toBeNull();

    map = setup();
    map.tap(onReadout(A));
    expect(map.copies).toBe(1);
    expect(map.chip).toBeNull();
    expect(map.viewer).toBeNull();

    // Dismissed, the pin is its own tap target again, and a tap away from
    // it closes the viewer and drops a fresh chip.
    map.tap(onReadout(A));
    expect(map.viewer).toBe('wp-1');
    map.tap([60, 650]);
    expect(map.viewer).toBeNull();
    expect(map.chip).toEqual([60, 650]);
  });

  it('keeps a chip dropped next to a pin clickable where the two overlap', () => {
    const map = new MapModel();
    map.pins.push({ id: 'wp-1', longitude: A[0], latitude: A[1] });
    // Just outside the pin's own tap disc, so this drops a chip…
    const B: Px = [A[0] + 70, A[1]];
    map.tap(B);
    expect(map.chip).toEqual(B);
    // …whose Navigate button lies INSIDE that disc.
    const button = onNavigate(B);
    const toBadge = Math.hypot(
      button[0] - A[0],
      button[1] - (A[1] - WAYPOINT_PIN_HIT.badgeOffsetPx),
    );
    expect(toBadge).toBeLessThan(WAYPOINT_PIN_HIT.radiusPx);
    map.tap(button);
    expect(map.navigatingTo).toEqual(B);
    expect(map.viewer).toBeNull();
  });

  it('still opens a pin tapped while a chip is open elsewhere', () => {
    const map = new MapModel();
    map.pins.push({ id: 'wp-1', longitude: A[0], latitude: A[1] });
    map.chip = [60, 650];
    map.tap([A[0], A[1] - WAYPOINT_PIN_HIT.badgeOffsetPx]);
    expect(map.viewer).toBe('wp-1');
    expect(map.chip).toEqual([60, 650]);
  });
});
