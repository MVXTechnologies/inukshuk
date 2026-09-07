import {
  NORTH_SNAP_DEG,
  NORTH_UP_EPSILON_DEG,
  isNorthUp,
  normalizeBearingDeg,
  shouldSnapToNorth,
} from './northSnap';

describe('normalizeBearingDeg', () => {
  it.each([
    [0, 0],
    [45, 45],
    [-45, -45],
    [350, -10],
    [359.5, -0.5],
    [180, 180],
    [-180, 180],
    [181, -179],
    [720, 0],
    [365, 5],
  ])('wraps %p to %p', (input, expected) => {
    expect(normalizeBearingDeg(input)).toBeCloseTo(expected, 6);
  });
});

describe('isNorthUp', () => {
  it('is true at north and within the epsilon, either side', () => {
    expect(isNorthUp(0)).toBe(true);
    expect(isNorthUp(0.5)).toBe(true);
    expect(isNorthUp(-0.5)).toBe(true);
    expect(isNorthUp(NORTH_UP_EPSILON_DEG)).toBe(true);
    // The wrap-around side of north is just as north-up.
    expect(isNorthUp(359.5)).toBe(true);
  });

  it('is false once the rotation is visible', () => {
    expect(isNorthUp(1.5)).toBe(false);
    expect(isNorthUp(-1.5)).toBe(false);
    expect(isNorthUp(45)).toBe(false);
  });
});

describe('shouldSnapToNorth', () => {
  it('snaps a small accidental rotation', () => {
    expect(shouldSnapToNorth(7.9)).toBe(true);
    expect(shouldSnapToNorth(-7.9)).toBe(true);
    expect(shouldSnapToNorth(3)).toBe(true);
    // Same rotation expressed the long way round the circle.
    expect(shouldSnapToNorth(352.1)).toBe(true);
  });

  it('keeps a rotation past the threshold', () => {
    expect(shouldSnapToNorth(8.1)).toBe(false);
    expect(shouldSnapToNorth(-8.1)).toBe(false);
    expect(shouldSnapToNorth(45)).toBe(false);
    expect(shouldSnapToNorth(180)).toBe(false);
    expect(shouldSnapToNorth(-90)).toBe(false);
  });

  it('snaps exactly on the threshold — the detent owns its edge', () => {
    expect(shouldSnapToNorth(NORTH_SNAP_DEG)).toBe(true);
    expect(shouldSnapToNorth(-NORTH_SNAP_DEG)).toBe(true);
  });

  it('does not snap when already north-up (this is what breaks the re-entrant loop)', () => {
    expect(shouldSnapToNorth(0)).toBe(false);
    expect(shouldSnapToNorth(0.5)).toBe(false);
    expect(shouldSnapToNorth(-0.5)).toBe(false);
    expect(shouldSnapToNorth(NORTH_UP_EPSILON_DEG)).toBe(false);
  });

  it('honours a caller-supplied threshold', () => {
    expect(shouldSnapToNorth(15, 20)).toBe(true);
    expect(shouldSnapToNorth(25, 20)).toBe(false);
  });

  it('documents the shipped detent width', () => {
    expect(NORTH_SNAP_DEG).toBe(8);
  });
});
