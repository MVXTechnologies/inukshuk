import { zoomForVisibleWidth } from './zoomForVisibleWidth';

const EARTH_CIRCUMFERENCE_M = 40075016.686;

/** Ground metres visible across `screenWidthPx` at `zoom`/`latitude` (512-px worlds). */
function visibleWidthAt(zoom: number, latitude: number, screenWidthPx: number): number {
  const metersPerPx =
    (EARTH_CIRCUMFERENCE_M * Math.cos((latitude * Math.PI) / 180)) / (512 * 2 ** zoom);
  return metersPerPx * screenWidthPx;
}

it('round-trips: the returned zoom shows exactly the requested width', () => {
  for (const lat of [0, 45.5, -33.9, 60]) {
    for (const width of [1000, 2500, 10000]) {
      const zoom = zoomForVisibleWidth(width, lat, 400);
      expect(visibleWidthAt(zoom, lat, 400)).toBeCloseTo(width, 6);
    }
  }
});

it('matches the known equator value', () => {
  // 2.5 km across 400 px at the equator: log2(40075016.686 * 400 / (512 * 2500)) ≈ 13.61
  expect(zoomForVisibleWidth(2500, 0, 400)).toBeCloseTo(13.61, 2);
});

it('needs a lower zoom away from the equator for the same ground width', () => {
  // Metres-per-pixel scales with cos(lat): at a fixed zoom, each pixel covers
  // fewer metres at high latitude, so the zoom that fits 2.5 km sits lower.
  const equator = zoomForVisibleWidth(2500, 0, 400);
  const mid = zoomForVisibleWidth(2500, 46, 400);
  const far = zoomForVisibleWidth(2500, 65, 400);
  expect(mid).toBeLessThan(equator);
  expect(far).toBeLessThan(mid);
});

it('is symmetric across the hemispheres', () => {
  expect(zoomForVisibleWidth(2500, 46, 400)).toBeCloseTo(zoomForVisibleWidth(2500, -46, 400), 10);
});

it('clamps polar latitudes to the Mercator domain instead of degenerating', () => {
  expect(zoomForVisibleWidth(2500, 90, 400)).toBe(zoomForVisibleWidth(2500, 85, 400));
  expect(Number.isFinite(zoomForVisibleWidth(2500, 90, 400))).toBe(true);
});

it('clamps the result to the [0, 22] zoom range', () => {
  expect(zoomForVisibleWidth(EARTH_CIRCUMFERENCE_M * 10, 0, 100)).toBe(0); // wider than Earth
  expect(zoomForVisibleWidth(0.001, 0, 4000)).toBe(22); // absurdly narrow
});

it('returns 0 for junk widths instead of NaN', () => {
  expect(zoomForVisibleWidth(0, 45, 400)).toBe(0);
  expect(zoomForVisibleWidth(-5, 45, 400)).toBe(0);
  expect(zoomForVisibleWidth(2500, 45, 0)).toBe(0);
  expect(zoomForVisibleWidth(Number.NaN, 45, 400)).toBe(0);
});
