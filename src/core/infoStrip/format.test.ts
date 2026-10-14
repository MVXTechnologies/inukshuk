import { formatClockTime, IMPERIAL, METRIC, NAUTICAL } from '@core/format';

import {
  bearingValue,
  DAY_MS,
  formatArrival,
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
    expect(formatDistanceIn(1234, 'app', METRIC)).toBe('1.23 km');
    expect(formatDistanceIn(250, 'app', IMPERIAL)).toBe('820 ft');
    expect(formatDistanceIn(1234, 'km', IMPERIAL)).toBe('1.23 km');
    expect(formatDistanceIn(5000, 'mi', METRIC)).toBe('3.11 mi');
    expect(formatDistanceIn(1852 * 1.5, 'nmi', METRIC)).toBe('1.50 NM');
    expect(formatDistanceIn(1852 * 12.34, 'nmi', METRIC)).toBe('12.3 NM');
    // Under a cable, NM falls back to the app's elevation unit (#702).
    expect(formatDistanceIn(-5, 'nmi', METRIC)).toBe('0 m');
    expect(formatDistanceIn(100, 'nmi', IMPERIAL)).toBe('328 ft');
    // The app's own NM setting.
    expect(formatDistanceIn(1852 * 1.5, 'app', NAUTICAL)).toBe('1.50 NM');
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

  it('an arrival: the clock time, with the day once it is more than 24 h away', () => {
    // Tuesday 2026-10-13, 12:00 local.
    const now = new Date(2026, 9, 13, 12, 0).getTime();
    expect(formatArrival(now + 3_600_000, now)).toBe(formatClockTime(now + 3_600_000));
    expect(formatArrival(now + DAY_MS, now)).toBe(formatClockTime(now + DAY_MS));
    const thu = new Date(2026, 9, 15, 14, 32).getTime();
    expect(formatArrival(thu, now)).toBe(`Thu ${formatClockTime(thu)}`);
  });
});
