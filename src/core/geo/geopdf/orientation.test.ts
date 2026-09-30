import type { CornerCoordinates } from '@core/models';
import {
  MIRROR_CHECK_MAX_SPAN_DEG,
  PDF_RASTER_ROTATION,
  displayedCorners,
  isMirroredSheet,
  normalizePageRotation,
  rasterPixelOfPagePoint,
} from './orientation';

const NORTH_UP: CornerCoordinates = {
  topLeft: [-70, 47],
  topRight: [-69, 47],
  bottomRight: [-69, 46],
  bottomLeft: [-70, 46],
};

describe('normalizePageRotation', () => {
  it.each([
    [0, 0],
    [90, 90],
    [180, 180],
    [270, 270],
    [360, 0],
    [450, 90],
    [-90, 270],
    [-180, 180],
  ])('/Rotate %p → %p', (input, expected) => {
    expect(normalizePageRotation(input)).toBe(expected);
  });

  it.each([[45], [Number.NaN], [Infinity], ['90'], [undefined], [null]])(
    'ignores %p as 0, like pdf.js',
    (input) => {
      expect(normalizePageRotation(input)).toBe(0);
    },
  );
});

describe('rasterPixelOfPagePoint', () => {
  const box = { x0: 10, y0: 20, x1: 210, y1: 120 };

  it('puts the user-space top-left of the box at pixel (0, 0), y growing down', () => {
    expect(rasterPixelOfPagePoint(box, 2, 10, 120)).toEqual([0, 0]);
    expect(rasterPixelOfPagePoint(box, 2, 210, 120)).toEqual([400, 0]);
    expect(rasterPixelOfPagePoint(box, 2, 210, 20)).toEqual([400, 200]);
    expect(rasterPixelOfPagePoint(box, 2, 10, 20)).toEqual([0, 200]);
  });

  it('is the rotation-0 contract', () => {
    expect(PDF_RASTER_ROTATION).toBe(0);
  });
});

describe('displayedCorners', () => {
  it('leaves an unrotated page as rasterized', () => {
    expect(displayedCorners(NORTH_UP, 0)).toEqual(NORTH_UP);
  });

  it('turns a quarter clockwise per 90°: the bottom-left comes to the top-left', () => {
    expect(displayedCorners(NORTH_UP, 90)).toEqual({
      topLeft: NORTH_UP.bottomLeft,
      topRight: NORTH_UP.topLeft,
      bottomRight: NORTH_UP.topRight,
      bottomLeft: NORTH_UP.bottomRight,
    });
    expect(displayedCorners(NORTH_UP, 180)).toEqual({
      topLeft: NORTH_UP.bottomRight,
      topRight: NORTH_UP.bottomLeft,
      bottomRight: NORTH_UP.topLeft,
      bottomLeft: NORTH_UP.topRight,
    });
    expect(displayedCorners(NORTH_UP, 270)).toEqual({
      topLeft: NORTH_UP.topRight,
      topRight: NORTH_UP.bottomRight,
      bottomRight: NORTH_UP.bottomLeft,
      bottomLeft: NORTH_UP.topLeft,
    });
  });

  it('composes: four quarter turns are the identity', () => {
    let c = NORTH_UP;
    for (let i = 0; i < 4; i++) c = displayedCorners(c, 90);
    expect(c).toEqual(NORTH_UP);
  });
});

describe('isMirroredSheet', () => {
  it('accepts a north-up sheet and any rotation of it', () => {
    for (const r of [0, 90, 180, 270] as const) {
      expect(isMirroredSheet(displayedCorners(NORTH_UP, r))).toBe(false);
    }
  });

  it('flags a sheet flipped north–south (the #487 corners)', () => {
    const flipped: CornerCoordinates = {
      topLeft: NORTH_UP.bottomLeft,
      topRight: NORTH_UP.bottomRight,
      bottomRight: NORTH_UP.topRight,
      bottomLeft: NORTH_UP.topLeft,
    };
    expect(isMirroredSheet(flipped)).toBe(true);
  });

  it('does not judge continent-wide insets', () => {
    // A CanTopo Lambert locator inset: its top corners wrap past the pole.
    const inset: CornerCoordinates = {
      topLeft: [168.7, 59.73],
      topRight: [0.27, 61.25],
      bottomRight: [-62.84, 32.25],
      bottomLeft: [-129.41, 31.57],
    };
    expect(isMirroredSheet(inset)).toBe(false);
    // Wound like a mirrored sheet, but too tall to be one.
    const south = 47 - MIRROR_CHECK_MAX_SPAN_DEG - 1;
    const wide: CornerCoordinates = {
      topLeft: [-70, south],
      topRight: [-69, south],
      bottomRight: [-69, 47],
      bottomLeft: [-70, 47],
    };
    expect(isMirroredSheet(wide)).toBe(false);
    expect(isMirroredSheet({ ...wide, topLeft: [-70, 46], topRight: [-69, 46] })).toBe(true);
  });
});
