import {
  formatBytes,
  formatDistance,
  formatDuration,
  formatElevation,
  formatPace,
  formatSpeed,
  formatTimestamp,
  headingToCardinal,
  setDisplayUnits,
} from './format';

afterEach(() => setDisplayUnits('metric'));

describe('formatDistance (metric)', () => {
  it('uses metres below 1 km', () => {
    expect(formatDistance(0)).toBe('0 m');
    expect(formatDistance(840)).toBe('840 m');
    expect(formatDistance(999)).toBe('999 m');
  });
  it('uses km at or above 1 km', () => {
    expect(formatDistance(1000)).toBe('1.00 km');
    expect(formatDistance(1234)).toBe('1.23 km');
  });
  it('never renders "1000 m" on the rounding boundary', () => {
    expect(formatDistance(999.4)).toBe('999 m');
    expect(formatDistance(999.5)).toBe('1.00 km');
    expect(formatDistance(999.99)).toBe('1.00 km');
  });
  it('guards bad input', () => {
    expect(formatDistance(-5)).toBe('0 m');
    expect(formatDistance(NaN)).toBe('0 m');
  });
});

describe('formatDistance (imperial)', () => {
  beforeEach(() => setDisplayUnits('imperial'));

  it('uses whole feet for short distances', () => {
    expect(formatDistance(0)).toBe('0 ft');
    expect(formatDistance(100)).toBe('328 ft');
  });
  it('switches to miles where feet would round to 1000', () => {
    expect(formatDistance(999.4 * 0.3048)).toBe('999 ft');
    expect(formatDistance(1000 * 0.3048)).toBe('0.19 mi');
  });
  it('uses 2 decimals below 10 mi and 1 decimal above', () => {
    expect(formatDistance(1609.344)).toBe('1.00 mi');
    expect(formatDistance(5 * 1609.344)).toBe('5.00 mi');
    expect(formatDistance(12 * 1609.344)).toBe('12.0 mi');
  });
  it('guards bad input', () => {
    expect(formatDistance(-5)).toBe('0 ft');
    expect(formatDistance(NaN)).toBe('0 ft');
  });
});

describe('formatDuration', () => {
  it('formats minutes and seconds', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65)).toBe('1:05');
  });
  it('formats hours', () => {
    expect(formatDuration(3661)).toBe('1:01:01');
  });
  it('guards negatives', () => {
    expect(formatDuration(-10)).toBe('0:00');
  });
});

describe('formatElevation', () => {
  it('rounds to whole metres', () => {
    expect(formatElevation(1234.6)).toBe('1235 m');
  });
  it('renders whole feet in imperial', () => {
    setDisplayUnits('imperial');
    expect(formatElevation(1234)).toBe('4049 ft');
    expect(formatElevation(NaN)).toBe('0 ft');
  });
});

describe('formatSpeed', () => {
  it('converts m/s to km/h', () => {
    expect(formatSpeed(0)).toBe('0.0 km/h');
    expect(formatSpeed(10)).toBe('36.0 km/h');
  });
  it('converts m/s to mph in imperial', () => {
    setDisplayUnits('imperial');
    expect(formatSpeed(10)).toBe('22.4 mph');
    expect(formatSpeed(-1)).toBe('0.0 mph');
  });
});

describe('formatPace', () => {
  it('converts m/s to min/km', () => {
    expect(formatPace(1000 / 360)).toBe('6:00/km'); // 360 s/km
    expect(formatPace(10 / 3.6)).toBe('6:00/km'); // 10 km/h
  });
  it('converts m/s to min/mi in imperial', () => {
    setDisplayUnits('imperial');
    expect(formatPace(1609.344 / 360)).toBe('6:00/mi'); // 360 s/mi
    expect(formatPace(0)).toBe('—');
  });
  it('returns a dash for non-positive or implausible speeds', () => {
    expect(formatPace(0)).toBe('—');
    expect(formatPace(-1)).toBe('—');
    expect(formatPace(0.01)).toBe('—');
  });
});

describe('headingToCardinal', () => {
  it('maps degrees to cardinals', () => {
    expect(headingToCardinal(0)).toBe('N');
    expect(headingToCardinal(45)).toBe('NE');
    expect(headingToCardinal(90)).toBe('E');
    expect(headingToCardinal(180)).toBe('S');
    expect(headingToCardinal(270)).toBe('W');
    expect(headingToCardinal(360)).toBe('N');
    expect(headingToCardinal(-90)).toBe('W');
  });
});

describe('formatTimestamp', () => {
  it('renders a short local date with a time component', () => {
    // Construct in local time so the assertion is timezone-independent.
    const epoch = new Date(2026, 5, 15, 14, 32).getTime();
    const out = formatTimestamp(epoch);
    expect(out).toContain('15');
    expect(out).toMatch(/\d{1,2}:32/);
  });
});

describe('formatBytes', () => {
  it('formats KB and MB', () => {
    expect(formatBytes(0)).toBe('0 KB');
    expect(formatBytes(840_000)).toBe('840 KB');
    expect(formatBytes(12_000_000)).toBe('12 MB');
  });
  it('has a GB tier', () => {
    expect(formatBytes(1_200_000_000)).toBe('1.2 GB');
  });
  it('guards NaN and negative input', () => {
    expect(formatBytes(NaN)).toBe('0 KB');
    expect(formatBytes(-1)).toBe('0 KB');
    expect(formatBytes(Infinity)).toBe('0 KB');
  });
});
