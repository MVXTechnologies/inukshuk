import {
  formatAngle,
  formatHeight,
  formatMetres,
  group,
  parseAngle,
  parseEpoch,
  parseMetres,
} from './format';

describe('parseAngle', () => {
  it.each([
    ['46.851168', 'lat', 46.851168],
    ['-71.238585', 'lon', -71.238585],
    ['71.238585° W', 'lon', -71.238585],
    ['W 71.238585', 'lon', -71.238585],
    ['46 51 04.2048 N', 'lat', 46 + 51 / 60 + 4.2048 / 3600],
    ["46°51.0701'N", 'lat', 46 + 51.0701 / 60],
    ['46,851168', 'lat', 46.851168],
  ] as const)('%s → %d', (t, axis, v) => {
    expect(parseAngle(t, axis)?.value).toBeCloseTo(v, 12);
  });

  it.each([
    ['46.85 E', 'lat'],
    ['-71.2 W', 'lon'],
    ['91', 'lat'],
    ['181', 'lon'],
    ['46 61 N', 'lat'],
    ['46.5 30 N', 'lat'],
    ['abc', 'lat'],
    ['', 'lat'],
  ] as const)('refuses %s (%s)', (t, axis) => {
    expect(parseAngle(t, axis)).toBeNull();
  });

  it('reports the precision of the last typed digit', () => {
    expect(parseAngle('46.851168', 'lat')?.precisionM).toBeCloseTo(0.111, 3);
    expect(parseAngle('46.85116812', 'lat')?.precisionM).toBeCloseTo(0.00111, 5);
    expect(parseAngle('46 51 04.2 N', 'lat')?.precisionM).toBeCloseTo(3.09, 1);
  });
});

describe('metres and epochs', () => {
  it('parses grouped metres with their precision', () => {
    expect(parseMetres('5 190 447.200')).toEqual({ value: 5190447.2, precisionM: 0.001 });
    expect(parseMetres('−3.127 m')?.value).toBe(-3.127);
    expect(parseMetres('3.1.2')).toBeNull();
  });
  it('parses epochs', () => {
    expect(parseEpoch('1997.0')).toBe(1997);
    expect(parseEpoch('2026.75')).toBe(2026.75);
    expect(parseEpoch('97')).toBeNull();
    expect(parseEpoch('1850')).toBeNull();
  });
});

describe('formatting', () => {
  it('groups thousands', () => {
    expect(group('5190447.241')).toBe('5 190 447.241');
    expect(group('n/a')).toBe('n/a');
    expect(formatMetres(-21.68)).toBe('−21.680');
    expect(formatHeight(24.4874)).toBe('24.487 m');
  });
  it('formats angles', () => {
    expect(formatAngle(46.851168, 'lat')).toBe('46.851168000° N');
    expect(formatAngle(-71.238585, 'lon', 'dms')).toBe('71° 14′ 18.90600″ W');
    expect(formatAngle(46.5, 'lat', 'ddm')).toBe('46° 30.0000000′ N');
    expect(formatAngle(45.99999999999, 'lat', 'dms')).toBe('46° 00′ 00.00000″ N');
  });
});
