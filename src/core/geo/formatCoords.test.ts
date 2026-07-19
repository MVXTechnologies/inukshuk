import { formatLatLng } from './formatCoords';

describe('formatLatLng', () => {
  it('formats five decimals in lat, lng order', () => {
    expect(formatLatLng(46.813944, -71.208201)).toBe('46.81394, -71.20820');
  });

  it('pads short values to a stable width', () => {
    expect(formatLatLng(46.8, -71.2)).toBe('46.80000, -71.20000');
  });

  it('handles the southern/western hemispheres and zero', () => {
    expect(formatLatLng(-33.856784, 151.215297)).toBe('-33.85678, 151.21530');
    expect(formatLatLng(0, 0)).toBe('0.00000, 0.00000');
  });
});
