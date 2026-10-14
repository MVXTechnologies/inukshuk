import {
  bearingValue,
  formatDistanceIn,
  formatHoursMinutes,
  signedDegrees,
  splitUnit,
} from './format';

describe('strip formatting', () => {
  it('splits a value from its unit', () => {
    expect(splitUnit('3.42 km')).toEqual({ value: '3.42', unit: 'km' });
    expect(splitUnit('≈412 m')).toEqual({ value: '≈412', unit: 'm' });
    expect(splitUnit('+412 m')).toEqual({ value: '+412', unit: 'm' });
    expect(splitUnit('13:53/km')).toEqual({ value: '13:53/km' });
    expect(splitUnit('—')).toEqual({ value: '—' });
  });

  it('formats a distance in the app units or a fixed unit', () => {
    expect(formatDistanceIn(1234, 'app', 'metric')).toBe('1.23 km');
    expect(formatDistanceIn(250, 'app', 'imperial')).toBe('820 ft');
    expect(formatDistanceIn(1234, 'km', 'imperial')).toBe('1.23 km');
    expect(formatDistanceIn(5000, 'mi', 'metric')).toBe('3.11 mi');
    expect(formatDistanceIn(1852 * 1.5, 'nmi', 'metric')).toBe('1.50 nmi');
    expect(formatDistanceIn(1852 * 12.34, 'nmi', 'metric')).toBe('12.3 nmi');
    expect(formatDistanceIn(-5, 'nmi', 'metric')).toBe('0.00 nmi');
  });

  it('formats bearings true and magnetic', () => {
    expect(bearingValue(42, false)).toEqual({ value: '042°', unit: 'NE' });
    expect(bearingValue(359.7, false)).toEqual({ value: '000°', unit: 'N' });
    expect(bearingValue(56.6, true)).toEqual({ value: '057°M', unit: 'NE' });
  });

  it('formats an ETE as H:MM, rounded up', () => {
    expect(formatHoursMinutes(0)).toBe('0:00');
    expect(formatHoursMinutes(1)).toBe('0:01');
    expect(formatHoursMinutes(21 * 60)).toBe('0:21');
    expect(formatHoursMinutes(3 * 3600 + 5 * 60 + 1)).toBe('3:06');
    expect(formatHoursMinutes(-5)).toBe('0:00');
  });

  it('signs a declination with a true minus', () => {
    expect(signedDegrees(-14.62)).toBe('−14.6°');
    expect(signedDegrees(2.14)).toBe('+2.1°');
    expect(signedDegrees(-0.02)).toBe('0.0°');
  });
});
