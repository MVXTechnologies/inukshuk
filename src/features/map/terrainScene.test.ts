import type { Heightmap } from './dem';
import { buildTerrain } from './terrainScene';

// A small, flat heightmap is enough to exercise the planar project/unproject
// mapping (the x/z ↔ lng/lat transform is independent of elevation).
function flatHm(): Heightmap {
  const grid = 8;
  return {
    data: new Float32Array(grid * grid).fill(120),
    grid,
    bbox: { minLng: -73.62, maxLng: -73.5, minLat: 45.5, maxLat: 45.6 },
    range: { z: 14, minX: 0, maxX: 1, minY: 0, maxY: 1 },
    minH: 120,
    maxH: 120,
  };
}

describe('buildTerrain project/unproject', () => {
  it('round-trips lng/lat → scene x/z → lng/lat', () => {
    const { project, unproject } = buildTerrain(flatHm(), []);
    for (const [lng, lat] of [
      [-73.6, 45.52],
      [-73.55, 45.58],
      [-73.51, 45.5],
    ] as const) {
      const v = project(lng, lat);
      const back = unproject(v.x, v.z);
      expect(back.lng).toBeCloseTo(lng, 6);
      expect(back.lat).toBeCloseTo(lat, 6);
    }
  });

  it('maps the bbox centre to ~the scene origin', () => {
    const hm = flatHm();
    const { project } = buildTerrain(hm, []);
    const midLng = (hm.bbox.minLng + hm.bbox.maxLng) / 2;
    const midLat = (hm.bbox.minLat + hm.bbox.maxLat) / 2;
    const v = project(midLng, midLat);
    expect(v.x).toBeCloseTo(0, 6);
    expect(v.z).toBeCloseTo(0, 6);
  });
});
