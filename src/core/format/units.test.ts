import {
  DISTANCE_UNITS,
  ELEVATION_UNITS,
  FT_PER_MI,
  IMPERIAL,
  M_PER_FT,
  M_PER_MI,
  M_PER_NMI,
  METRIC,
  NAUTICAL,
  defaultUnitsForLocale,
  distanceParts,
  distanceUnitLabel,
  distanceUnitName,
  elevationParts,
  formatAccuracy,
  formatDistance,
  formatDistanceMarker,
  formatElevation,
  formatElevationChange,
  formatInUnit,
  formatPace,
  formatSmallDistance,
  formatSpeed,
  formatWholeDistance,
  fromElevationUnit,
  fromUnit,
  groupThousands,
  metresPer,
  paceSuffix,
  rulerSystem,
  sameUnits,
  sanitizeUnits,
  smallDistanceUnit,
  speedParts,
  speedUnit,
  toElevationUnit,
  toSpeedUnit,
  toUnit,
  unitLabel,
  usesFahrenheit,
  type Units,
} from './units';

const NM_FT: Units = { distance: 'nmi', elevation: 'ft' };
const KM_FT: Units = { distance: 'km', elevation: 'ft' };
const MI_M: Units = { distance: 'mi', elevation: 'm' };
const NNBSP = '\u202f';

describe('conversions', () => {
  it('uses the exact international definitions', () => {
    expect(M_PER_FT).toBe(0.3048);
    expect(M_PER_MI).toBe(1609.344);
    expect(M_PER_NMI).toBe(1852);
    expect(FT_PER_MI * M_PER_FT).toBeCloseTo(M_PER_MI, 9);
  });

  it('converts metres to and from every unit', () => {
    expect(metresPer('km')).toBe(1000);
    expect(toUnit(1852, 'nmi')).toBe(1);
    expect(toUnit(1609.344, 'mi')).toBe(1);
    expect(toUnit(3.048, 'ft')).toBeCloseTo(10, 12);
    expect(toUnit(42, 'm')).toBe(42);
    for (const u of [...DISTANCE_UNITS, 'm', 'ft'] as const) {
      expect(fromUnit(toUnit(1234.5, u), u)).toBeCloseTo(1234.5, 9);
    }
  });

  it('converts heights by the elevation unit only', () => {
    expect(toElevationUnit(1000, METRIC)).toBe(1000);
    expect(toElevationUnit(1000, IMPERIAL)).toBeCloseTo(3280.84, 2);
    expect(toElevationUnit(1000, MI_M)).toBe(1000);
    expect(fromElevationUnit(toElevationUnit(-430, NM_FT), NM_FT)).toBeCloseTo(-430, 9);
  });

  it('converts speed by the distance unit: km/h, mph, knots', () => {
    expect(toSpeedUnit(10, METRIC)).toBeCloseTo(36, 9);
    expect(toSpeedUnit(10, IMPERIAL)).toBeCloseTo(22.3694, 4);
    expect(toSpeedUnit(10, NAUTICAL)).toBeCloseTo(19.4384, 4);
    expect(speedUnit(METRIC)).toBe('km/h');
    expect(speedUnit(IMPERIAL)).toBe('mph');
    expect(speedUnit(NM_FT)).toBe('kn');
  });
});

describe('labels', () => {
  it('prints km, mi and NM, and names them', () => {
    expect(DISTANCE_UNITS.map(distanceUnitLabel)).toEqual(['km', 'mi', 'NM']);
    expect(DISTANCE_UNITS.map(distanceUnitName)).toEqual(['kilometre', 'mile', 'nautical mile']);
    expect(unitLabel('ft')).toBe('ft');
    expect(unitLabel('m')).toBe('m');
    expect(unitLabel('nmi')).toBe('NM');
    expect(ELEVATION_UNITS).toEqual(['m', 'ft']);
  });

  it('falls back to metres under km, feet under miles, the elevation unit under NM', () => {
    expect(smallDistanceUnit(METRIC)).toBe('m');
    expect(smallDistanceUnit(KM_FT)).toBe('m');
    expect(smallDistanceUnit(IMPERIAL)).toBe('ft');
    expect(smallDistanceUnit(MI_M)).toBe('ft');
    expect(smallDistanceUnit(NAUTICAL)).toBe('m');
    expect(smallDistanceUnit(NM_FT)).toBe('ft');
    expect(rulerSystem(NAUTICAL)).toBe('metric');
    expect(rulerSystem(NM_FT)).toBe('imperial');
  });

  it('keeps °F to the US customary pair', () => {
    expect(usesFahrenheit(IMPERIAL)).toBe(true);
    expect(usesFahrenheit(METRIC)).toBe(false);
    expect(usesFahrenheit(MI_M)).toBe(false); // a Briton
    expect(usesFahrenheit(NM_FT)).toBe(false); // a sailor
    expect(usesFahrenheit(KM_FT)).toBe(false); // a pilot
  });

  it('compares units by value', () => {
    expect(sameUnits(METRIC, { distance: 'km', elevation: 'm' })).toBe(true);
    expect(sameUnits(METRIC, KM_FT)).toBe(false);
    expect(sameUnits(NAUTICAL, METRIC)).toBe(false);
  });
});

describe('settings', () => {
  it('migrates the pre-2.6.1 switch', () => {
    expect(sanitizeUnits('metric')).toBe(METRIC);
    expect(sanitizeUnits('imperial')).toBe(IMPERIAL);
  });

  it('accepts a whole, valid object and copies it', () => {
    const raw = { distance: 'nmi', elevation: 'ft', extra: 1 };
    expect(sanitizeUnits(raw)).toEqual(NM_FT);
    expect(sanitizeUnits(raw)).not.toBe(raw);
  });

  it.each([
    ['junk string', 'nautical'],
    ['number', 3],
    ['null', null],
    ['undefined', undefined],
    ['missing elevation', { distance: 'km' }],
    ['bad distance', { distance: 'league', elevation: 'm' }],
    ['bad elevation', { distance: 'km', elevation: 'yd' }],
    ['wrong types', { distance: 1, elevation: true }],
  ])('rejects %s', (_label, raw) => {
    expect(sanitizeUnits(raw)).toBeNull();
  });

  it.each([
    ['en-US', IMPERIAL],
    ['es-US', IMPERIAL],
    ['es-Latn-US', IMPERIAL],
    ['en_US', IMPERIAL],
    ['en-us', IMPERIAL],
    ['en-LR', IMPERIAL],
    ['my-MM', IMPERIAL],
    ['en-CA', METRIC],
    ['fr-CA', METRIC],
    ['en-GB', METRIC],
    ['en', METRIC],
    ['es-419', METRIC],
    ['', METRIC],
    [null, METRIC],
    [undefined, METRIC],
  ])('defaults %s to the region’s units', (locale, expected) => {
    expect(defaultUnitsForLocale(locale)).toBe(expected);
  });
});

describe('formatDistance', () => {
  it('reads metres under 1 km, never "1000 m" on the rounding boundary', () => {
    expect(formatDistance(0, METRIC)).toBe('0 m');
    expect(formatDistance(999.4, METRIC)).toBe('999 m');
    expect(formatDistance(999.5, METRIC)).toBe('1.00 km');
    expect(formatDistance(1234, METRIC)).toBe('1.23 km');
  });

  it('reads feet under 1000 ft for miles, never "1000 ft"', () => {
    expect(formatDistance(100, IMPERIAL)).toBe('328 ft');
    expect(formatDistance(999.4 * M_PER_FT, IMPERIAL)).toBe('999 ft');
    expect(formatDistance(999.5 * M_PER_FT, IMPERIAL)).toBe('0.19 mi');
    // The short unit is the distance's, whatever the height setting says.
    expect(formatDistance(100, MI_M)).toBe('328 ft');
    expect(formatDistance(100, KM_FT)).toBe('100 m');
  });

  it('reads the elevation unit under one cable (0.1 NM) for nautical miles', () => {
    expect(formatDistance(185, NAUTICAL)).toBe('185 m');
    expect(formatDistance(185, NM_FT)).toBe('607 ft');
    expect(formatDistance(185.2, NAUTICAL)).toBe('0.10 NM');
    expect(formatDistance(1852 * 2.5, NAUTICAL)).toBe('2.50 NM');
    expect(formatDistance(1852 * 2.5, NM_FT)).toBe('2.50 NM');
  });

  it('precise: two decimals below 10, one above, without "10.00"', () => {
    expect(formatDistance(9_994, METRIC)).toBe('9.99 km');
    expect(formatDistance(9_996, METRIC)).toBe('10.0 km');
    expect(formatDistance(12_345, METRIC)).toBe('12.3 km');
    expect(formatDistance(12 * M_PER_MI, IMPERIAL)).toBe('12.0 mi');
    expect(formatDistance(123_456, METRIC)).toBe('123.5 km');
  });

  it('tenths: one decimal below 100, whole and grouped above', () => {
    const t = { style: 'tenths' } as const;
    expect(formatDistance(11_240, METRIC, t)).toBe('11.2 km');
    expect(formatDistance(99_960, METRIC, t)).toBe('100 km');
    expect(formatDistance(142_300, METRIC, t)).toBe('142 km');
    expect(formatDistance(1_234_567, METRIC, t)).toBe(`1${NNBSP}235 km`);
    expect(formatDistance(840, METRIC, t)).toBe('840 m');
  });

  it('short: one decimal below 10, whole above, optionally the short unit in tens', () => {
    const s = { style: 'short', smallStep: 10 } as const;
    expect(formatDistance(4_240, METRIC, s)).toBe('4.2 km');
    expect(formatDistance(9_960, METRIC, s)).toBe('10 km');
    expect(formatDistance(17_400, IMPERIAL, s)).toBe('11 mi');
    expect(formatDistance(347, METRIC, s)).toBe('350 m');
    // 995 m rounds to 1000 in tens: that is the long unit.
    expect(formatDistance(995, METRIC, s)).toBe('1.0 km');
    expect(formatDistance(1852 * 3.21, NAUTICAL, s)).toBe('3.2 NM');
  });

  it('reads junk and negatives as zero', () => {
    for (const u of [METRIC, IMPERIAL, NAUTICAL, NM_FT]) {
      expect(formatDistance(Number.NaN, u)).toBe(`0 ${smallDistanceUnit(u)}`);
      expect(formatDistance(-5, u)).toBe(`0 ${smallDistanceUnit(u)}`);
      expect(formatDistance(Infinity, u)).toBe(`0 ${smallDistanceUnit(u)}`);
    }
  });

  it('splits value and unit for layouts that set the unit smaller', () => {
    expect(distanceParts(3420, METRIC)).toEqual({ value: '3.42', unit: 'km' });
    expect(distanceParts(50, NM_FT)).toEqual({ value: '164', unit: 'ft' });
  });

  it('has whole-unit, short-unit, marker and ruler variants', () => {
    expect(formatWholeDistance(12_345, METRIC)).toBe('12 km');
    expect(formatWholeDistance(2_000_000, IMPERIAL)).toBe(`1${NNBSP}243 mi`);
    expect(formatWholeDistance(-1, NAUTICAL)).toBe('0 NM');
    expect(formatSmallDistance(12.4, METRIC)).toBe('12 m');
    expect(formatSmallDistance(2, IMPERIAL)).toBe('7 ft');
    expect(formatSmallDistance(Number.NaN, NM_FT)).toBe('0 ft');
    expect(formatSmallDistance(5000, METRIC)).toBe(`5${NNBSP}000 m`);
    expect(formatDistanceMarker(3_240, METRIC)).toBe('km 3.2');
    expect(formatDistanceMarker(3_240, IMPERIAL)).toBe('mi 2.0');
    expect(formatDistanceMarker(-1, NAUTICAL)).toBe('NM 0.0');
    expect(formatInUnit(500, 'm', 0)).toBe('500 m');
    expect(formatInUnit(M_PER_MI / 2, 'mi')).toBe('0.5 mi');
    expect(formatInUnit(2 * M_PER_NMI, 'nmi')).toBe('2 NM');
    expect(formatInUnit(Number.NaN, 'km')).toBe('0 km');
    expect(formatInUnit(-0.0001, 'km')).toBe('0 km');
  });

  it('states an accuracy in the short unit, never below 1', () => {
    expect(formatAccuracy(4.6, METRIC)).toBe('±5 m');
    expect(formatAccuracy(4.6, IMPERIAL)).toBe('±15 ft');
    expect(formatAccuracy(0.2, METRIC)).toBe('±1 m');
    expect(formatAccuracy(Number.NaN, NM_FT)).toBe('±1 ft');
  });
});

describe('formatElevation', () => {
  it('rounds to the metre or the foot', () => {
    expect(formatElevation(1234.4, METRIC)).toBe('1234 m');
    expect(formatElevation(1234, IMPERIAL)).toBe('4049 ft');
    // Heights follow the elevation setting alone.
    expect(formatElevation(1234, MI_M)).toBe('1234 m');
    expect(formatElevation(1234, KM_FT)).toBe('4049 ft');
  });

  it('keeps a true minus below the datum and never reads "-0"', () => {
    expect(formatElevation(-430, METRIC)).toBe('−430 m');
    expect(formatElevation(-430, IMPERIAL)).toBe('−1411 ft');
    expect(formatElevation(-0.4, METRIC)).toBe('0 m');
    expect(formatElevation(-0.1, IMPERIAL)).toBe('0 ft');
    expect(formatElevation(Number.NaN, IMPERIAL)).toBe('0 ft');
  });

  it('rounds to a step, groups thousands, or keeps decimals', () => {
    expect(formatElevation(1847, METRIC, { step: 10, grouped: true })).toBe(`1${NNBSP}850 m`);
    expect(formatElevation(1847, IMPERIAL, { step: 10, grouped: true })).toBe(`6${NNBSP}060 ft`);
    expect(formatElevation(1.234, METRIC, { decimals: 1 })).toBe('1.2 m');
    expect(formatElevation(-0.567, IMPERIAL, { decimals: 2 })).toBe('−1.86 ft');
    expect(formatElevation(-0.001, METRIC, { decimals: 2 })).toBe('0.00 m');
    expect(elevationParts(412, IMPERIAL)).toEqual({ value: '1352', unit: 'ft' });
  });

  it('signs climbs and drops but never zero', () => {
    expect(formatElevationChange(120, 'up', METRIC)).toBe('+120 m');
    expect(formatElevationChange(85, 'down', IMPERIAL)).toBe('−279 ft');
    expect(formatElevationChange(0.2, 'up', METRIC)).toBe('0 m');
  });
});

describe('speed and pace', () => {
  it('formats speed in km/h, mph or knots', () => {
    expect(formatSpeed(10, METRIC)).toBe('36.0 km/h');
    expect(formatSpeed(10, IMPERIAL)).toBe('22.4 mph');
    expect(formatSpeed(10, NAUTICAL)).toBe('19.4 kn');
    expect(speedParts(-1, NM_FT)).toEqual({ value: '0.0', unit: 'kn' });
    expect(formatSpeed(Number.NaN, METRIC)).toBe('0.0 km/h');
  });

  it('formats pace per km, mile or nautical mile', () => {
    expect(formatPace(1000 / 360, METRIC)).toBe('6:00/km');
    expect(formatPace(M_PER_MI / 579, IMPERIAL)).toBe('9:39/mi');
    expect(formatPace(M_PER_NMI / 324, NAUTICAL)).toBe('5:24/NM');
    expect(paceSuffix(NM_FT)).toBe('/NM');
  });

  it('carries a second that rounds to 60, and dashes the implausible', () => {
    expect(formatPace(1000 / 359.6, METRIC)).toBe('6:00/km');
    expect(formatPace(1000 / 59.7, METRIC)).toBe('1:00/km');
    expect(formatPace(0.05, METRIC)).toBe('—');
    expect(formatPace(Number.NaN, METRIC)).toBe('—');
    expect(formatPace(0.15, NAUTICAL)).toBe('—'); // > 99 min per NM
  });
});

describe('groupThousands', () => {
  it('groups the integer part with a narrow no-break space', () => {
    expect(groupThousands(999)).toBe('999');
    expect(groupThousands(1000)).toBe(`1${NNBSP}000`);
    expect(groupThousands(1234567.5)).toBe(`1${NNBSP}234${NNBSP}567.5`);
  });
});
