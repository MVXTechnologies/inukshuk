import { badgeIndex, formatDistanceShort, sourceAbbreviation } from './exploreFormat';

it('shortens the distance', () => {
  expect(formatDistanceShort(12_300, 'metric')).toBe('12 km');
  expect(formatDistanceShort(200, 'metric')).toBe('< 1 km');
  expect(formatDistanceShort(16_093, 'imperial')).toBe('10 mi');
});

it('abbreviates publishers', () => {
  expect(sourceAbbreviation('NRCan CanTopo')).toBe('NRCan');
  expect(sourceAbbreviation('USGS US Topo')).toBe('USGS');
  expect(sourceAbbreviation('Geoscience Australia AUSTopo')).toBe('GAA');
  expect(sourceAbbreviation('Natural Resources Canada')).toBe('NRC');
  expect(sourceAbbreviation('fixtures')).toBe('FI');
});

it('picks a stable badge colour in range', () => {
  expect(badgeIndex('nrcan-cantopo', 4)).toBe(badgeIndex('nrcan-cantopo', 4));
  for (const id of ['a', 'usgs-ustopo', 'noaa-bookletchart']) {
    const i = badgeIndex(id, 4);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(4);
  }
  expect(badgeIndex('x', 0)).toBe(0);
});
