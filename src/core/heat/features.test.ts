import { runFeatures } from './features';

const pts = [
  { longitude: -71.2082, latitude: 46.8139 },
  { longitude: -71.208, latitude: 46.814 },
  { longitude: -71.2078, latitude: 46.8141 },
  { longitude: -71.2076, latitude: 46.8142 },
];

describe('runFeatures', () => {
  it('builds one LineString per run with the right slice and properties', () => {
    const features = runFeatures(
      't1',
      'run',
      pts,
      [
        { startIdx: 0, endIdx: 2, count: 1 },
        { startIdx: 2, endIdx: 3, count: 3 },
      ],
      '#aabbcc',
      '#ff0000',
    );
    expect(features).toHaveLength(2);
    const cold = features[0];
    const hot = features[1];
    expect(cold?.geometry.coordinates).toHaveLength(3);
    expect(cold?.properties).toEqual({
      trackId: 't1',
      categoryId: 'run',
      count: 1,
      hot: false,
      color: '#aabbcc',
    });
    expect(hot?.geometry.coordinates).toEqual([
      [-71.2078, 46.8141],
      [-71.2076, 46.8142],
    ]);
    expect(hot?.properties.hot).toBe(true);
    expect(hot?.properties.color).toBe('#ff0000');
    expect(hot?.properties.count).toBe(3);
  });

  it('skips degenerate runs (fewer than 2 coordinates)', () => {
    const features = runFeatures(
      't1',
      'run',
      pts,
      [{ startIdx: 1, endIdx: 1, count: 1 }],
      '#aabbcc',
      '#ff0000',
    );
    expect(features).toHaveLength(0);
  });
});
