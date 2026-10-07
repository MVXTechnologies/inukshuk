import { mapAlongPoints, photosOnAxis } from './axis';
import type { TrackPhoto } from './model';

// Five points; a 400 m pause gap between points 2 and 3 that the view's axis skips.
const indexCum = [0, 100, 200, 600, 700];
const axisCum = [0, 100, 200, 200, 300];

describe('mapAlongPoints', () => {
  it('maps a distance by its place between two points', () => {
    expect(mapAlongPoints(indexCum, axisCum, 50)).toBe(50);
    expect(mapAlongPoints(indexCum, axisCum, 650)).toBe(250);
    // Inside the skipped gap: the axis does not move.
    expect(mapAlongPoints(indexCum, axisCum, 400)).toBe(200);
  });

  it('clamps to the ends and copes with tiny trails', () => {
    expect(mapAlongPoints(indexCum, axisCum, -5)).toBe(0);
    expect(mapAlongPoints(indexCum, axisCum, 9999)).toBe(300);
    expect(mapAlongPoints([], [], 10)).toBe(0);
    expect(mapAlongPoints([0], [0], 10)).toBe(0);
  });

  it('handles repeated points (zero-length steps)', () => {
    expect(mapAlongPoints([0, 0, 10], [0, 0, 10], 0)).toBe(0);
    expect(mapAlongPoints([0, 10, 10, 20], [0, 10, 10, 20], 15)).toBe(15);
  });
});

it('places photos on the axis', () => {
  const photo = { id: 'a', distanceM: 650 } as TrackPhoto;
  expect(photosOnAxis([photo], indexCum, axisCum)).toEqual([{ photo, distanceM: 250 }]);
});
