import {
  clampLat,
  EARTH_CIRCUMFERENCE_M,
  latToMercY,
  lngToMercX,
  MAX_MERCATOR_LAT,
  mercXToLng,
  mercYToLat,
  pixelsPerMeter,
  tileSizeMeters,
  worldSize,
  wrapLng,
} from './mercator';

describe('mercator', () => {
  it('world size doubles per zoom from 512', () => {
    expect(worldSize(0)).toBe(512);
    expect(worldSize(1)).toBe(1024);
    expect(worldSize(13.5)).toBeCloseTo(512 * 2 ** 13.5, 6);
  });

  it('the equator and the prime meridian are the centre', () => {
    expect(lngToMercX(0)).toBe(0.5);
    expect(latToMercY(0)).toBeCloseTo(0.5, 15);
  });

  it('the Mercator limit maps to the edges, beyond is clamped', () => {
    expect(latToMercY(MAX_MERCATOR_LAT)).toBeCloseTo(0, 9);
    expect(latToMercY(-MAX_MERCATOR_LAT)).toBeCloseTo(1, 9);
    expect(latToMercY(89.9)).toBeCloseTo(0, 9);
    expect(latToMercY(-90)).toBeCloseTo(1, 9);
    expect(clampLat(91)).toBe(MAX_MERCATOR_LAT);
  });

  const lngs = [-180, -179.999, -120.5, -70.9, 0, 6.87, 7.75, 119.5, 179.999];
  it.each(lngs)('lng %p round-trips', (lng) => {
    expect(mercXToLng(lngToMercX(lng))).toBeCloseTo(lng, 9);
  });

  const lats = [-85, -60, -36.1, -1e-6, 0, 1e-6, 36.1, 45.92, 46.02, 47.07, 60, 80, 85];
  it.each(lats)('lat %p round-trips', (lat) => {
    expect(mercYToLat(latToMercY(lat))).toBeCloseTo(lat, 9);
  });

  it('north is smaller y (y grows south)', () => {
    expect(latToMercY(46)).toBeLessThan(latToMercY(45));
  });

  it('pixels per metre doubles at 60° and per zoom', () => {
    const eq = pixelsPerMeter(0, 10);
    expect(pixelsPerMeter(60, 10) / eq).toBeCloseTo(2, 9);
    expect(pixelsPerMeter(0, 11) / eq).toBeCloseTo(2, 12);
    expect(eq).toBeCloseTo(worldSize(10) / EARTH_CIRCUMFERENCE_M, 15);
  });

  it('tile size in metres halves per zoom and shrinks with cos(lat)', () => {
    expect(tileSizeMeters(0, 0)).toBeCloseTo(EARTH_CIRCUMFERENCE_M, 6);
    expect(tileSizeMeters(1, 0)).toBeCloseTo(EARTH_CIRCUMFERENCE_M / 2, 6);
    expect(tileSizeMeters(10, 60)).toBeCloseTo(tileSizeMeters(10, 0) / 2, 6);
  });

  it.each([
    [0, 0],
    [180, -180],
    [-180, -180],
    [190, -170],
    [-190, 170],
    [540, -180],
    [359.5, -0.5],
  ])('wrapLng(%p) = %p', (a, b) => {
    expect(wrapLng(a)).toBeCloseTo(b, 9);
  });
});
