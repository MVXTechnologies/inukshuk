import { cellAt, HEAT_CELL_M } from './grid';
import { buildHeatIndex, MAX_TAP_RADIUS_M, trailsNearWithin } from './heatIndex';
import { traceCells } from './trace';

// A straight east-west trail through Québec City, sampled every 10 m.
const LAT = 46.81;
const mPerDegLng = 111320 * Math.cos((LAT * Math.PI) / 180);
const line = (id: string, latOffsetM = 0) => ({
  id,
  categoryId: 'run',
  dilated: traceCells(
    Array.from({ length: 200 }, (_, i) => ({
      longitude: -71.22 + (i * 10) / mPerDegLng,
      latitude: LAT + latOffsetM / 111320,
    })),
  ).dilated,
});

const at = (index: ReturnType<typeof buildHeatIndex>, northM: number, radiusM: number) =>
  trailsNearWithin(index, -71.21, LAT + northM / 111320, radiusM, cellAt, HEAT_CELL_M);

describe('trailsNearWithin (tap tolerance)', () => {
  const index = buildHeatIndex([line('a')]);

  it('finds a trail right under the finger with no extra radius', () => {
    expect(at(index, 0, 0).trackIds).toEqual(['a']);
  });

  it('misses a trail 150 m away with the bare cell ring (the old behaviour)', () => {
    expect(at(index, 150, 0).trackIds).toEqual([]);
  });

  it('finds it once the tolerance covers the distance (a zoomed-out tap)', () => {
    expect(at(index, 150, 200).trackIds).toEqual(['a']);
  });

  it('still misses a trail beyond the tolerance', () => {
    expect(at(index, 600, 200).trackIds).toEqual([]);
  });

  it('prefers the nearest of two trails', () => {
    const two = buildHeatIndex([line('near', 120), line('far', -400)]);
    expect(at(two, 0, 500).trackIds).toEqual(['near']);
  });

  it('caps the search radius', () => {
    expect(at(index, MAX_TAP_RADIUS_M + 800, 1e9).trackIds).toEqual([]);
  });
});
