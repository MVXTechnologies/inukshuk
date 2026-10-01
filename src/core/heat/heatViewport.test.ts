import type { FeatureCollection, MultiLineString, Point } from 'geojson';

import type { HeatGlowProps, HeatLineProps } from './heatGrid';
import { glowWithin, heatLinesWithin, indexHeatLines } from './heatViewport';

const lines = (
  ...buckets: [count: number, chains: [number, number][][]][]
): FeatureCollection<MultiLineString, HeatLineProps> => ({
  type: 'FeatureCollection',
  features: buckets.map(([count, coordinates]) => ({
    type: 'Feature',
    geometry: { type: 'MultiLineString', coordinates },
    properties: { count },
  })),
});

/** A chain due east along `lat`, `n` vertices 0.001° apart from `lng0`. */
const chain = (lng0: number, lat: number, n: number): [number, number][] =>
  Array.from({ length: n }, (_, i) => [lng0 + i * 0.001, lat]);

describe('heatLinesWithin', () => {
  const fc = lines(
    [1, [chain(0, 0, 100), chain(0, 1, 10)]],
    [4, [chain(5, 5, 10)]],
    [8, [[[0, 0]]]], // a degenerate chain is dropped at indexing
  );
  const index = indexHeatLines(fc);

  it('keeps the bucket shape and order, dropping empty buckets', () => {
    const all = heatLinesWithin(index, { minLng: -180, minLat: -90, maxLng: 180, maxLat: 90 });
    expect(all.features.map((f) => f.properties.count)).toEqual([1, 4]);
    expect(all.features[0]?.geometry.coordinates).toHaveLength(2);
  });

  it('cuts chains to the region and drops the rest', () => {
    const near = heatLinesWithin(index, { minLng: 0.02, minLat: -0.1, maxLng: 0.03, maxLat: 0.1 });
    expect(near.features).toHaveLength(1);
    const [piece] = near.features[0]?.geometry.coordinates ?? [];
    expect(piece?.length).toBeLessThan(100);
    expect(piece?.[0]?.[0]).toBeLessThanOrEqual(0.02);
    expect(piece?.[piece.length - 1]?.[0]).toBeGreaterThanOrEqual(0.03);
    expect(
      heatLinesWithin(index, { minLng: 50, minLat: 50, maxLng: 51, maxLat: 51 }).features,
    ).toEqual([]);
  });
});

describe('glowWithin', () => {
  const glow: FeatureCollection<Point, HeatGlowProps> = {
    type: 'FeatureCollection',
    features: [
      [0, 0],
      [179.5, 0],
      [-179.5, 0],
      [10, 10],
    ].map(([lng, lat], i) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng as number, lat as number] },
      properties: { count: i + 1 },
    })),
  };

  it('keeps the points inside the region, edges included', () => {
    const out = glowWithin(glow, { minLng: -1, minLat: -1, maxLng: 10, maxLat: 10 });
    expect(out.features.map((f) => f.properties.count)).toEqual([1, 4]);
  });

  it('handles a region across the antimeridian', () => {
    const out = glowWithin(glow, { minLng: 179, minLat: -1, maxLng: -179, maxLat: 1 });
    expect(out.features.map((f) => f.properties.count)).toEqual([2, 3]);
  });
});
