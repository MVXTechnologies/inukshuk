import { IMPERIAL, METRIC, NAUTICAL } from '@core/format';
import {
  CUSTOM_LENGTH_MAX_M,
  CUSTOM_LENGTH_MIN_M,
  clampCustomLengthM,
  customLengthInputText,
  customLengthInputUnit,
  parseCustomLength,
  pointingLineChoiceM,
  DEFAULT_POINTING_LINE,
  IMPERIAL_LENGTH_FT,
  POINTING_LINE_COLORS,
  formatFixedBearing,
  parseBearing,
  pointingLineCaption,
  pointingLineCasing,
  pointingLineGroundNote,
  pointingLineLengthLabels,
  pointingLineLengthM,
  pointingLineLengthText,
  pointingLineSummary,
  pointingLineTicksLabel,
  sanitizePointingLine,
} from './pointingLineSettings';

describe('sanitizePointingLine', () => {
  it('is off by default, 500 m along your heading in red', () => {
    expect(DEFAULT_POINTING_LINE).toMatchObject({
      enabled: false,
      origin: 'you',
      direction: 'heading',
      length: 500,
      color: '#D32F2F',
      width: 'medium',
      ticks: 50,
      labelEvery5th: false,
    });
  });

  it('falls back to the defaults for a missing or malformed value', () => {
    for (const raw of [undefined, null, 'on', 3, true, [], [1, 2]]) {
      expect(sanitizePointingLine(raw)).toEqual(DEFAULT_POINTING_LINE);
    }
  });

  it('keeps every valid field', () => {
    const s = {
      enabled: true,
      origin: 'you',
      direction: 'fixed',
      fixedBearingDeg: 62,
      length: 'edge',
      color: '#1E64C8',
      width: 'bold',
      ticks: 'auto',
      labelEvery5th: true,
      customLengthM: 1234,
    } as const;
    expect(sanitizePointingLine(s)).toEqual(s);
  });

  it('repairs each bad field on its own, keeping the good ones', () => {
    const s = sanitizePointingLine({
      enabled: 'yes',
      origin: 'cursor', // a later build's origin
      direction: 'north',
      fixedBearingDeg: 370.4,
      length: 750,
      color: '#123456',
      width: 'huge',
      ticks: 25,
      labelEvery5th: 1,
      somethingNew: { a: 1 },
    });
    expect(s).toEqual({ ...DEFAULT_POINTING_LINE, fixedBearingDeg: 10 });
    expect(sanitizePointingLine({ color: '#1e64c8' }).color).toBe('#1E64C8');
    expect(sanitizePointingLine({ fixedBearingDeg: -5 }).fixedBearingDeg).toBe(355);
    expect(sanitizePointingLine({ fixedBearingDeg: NaN }).fixedBearingDeg).toBe(0);
    expect(sanitizePointingLine({ fixedBearingDeg: '62' }).fixedBearingDeg).toBe(0);
  });
});

describe('pointing line labels', () => {
  it('parses a typed bearing into whole degrees in [0, 360)', () => {
    expect(parseBearing('62')).toBe(62);
    expect(parseBearing(' 359.6 ')).toBe(0);
    expect(parseBearing('360')).toBe(0);
    expect(parseBearing('-90')).toBe(270);
    expect(parseBearing('')).toBeNull();
    expect(parseBearing('abc')).toBeNull();
    expect(parseBearing(undefined)).toBeNull();
  });

  it('writes bearings, lengths, ticks and the row summary', () => {
    expect(formatFixedBearing(62)).toBe('062°');
    expect(formatFixedBearing(359.7)).toBe('000°');
    expect(pointingLineLengthText(250)).toBe('250 m');
    expect(pointingLineLengthText(2000)).toBe('2 km');
    expect(pointingLineLengthText('edge')).toBe('To the edge');
    expect(pointingLineTicksLabel('off', METRIC)).toBe('Off');
    expect(pointingLineTicksLabel(10, METRIC)).toBe('10 m');
    expect(pointingLineTicksLabel('auto', METRIC)).toBe('Auto');
    // Imperial: the round-feet step each choice stands for.
    expect(pointingLineTicksLabel('off', IMPERIAL)).toBe('Off');
    expect(pointingLineTicksLabel(10, IMPERIAL)).toBe('50 ft');
    expect(pointingLineTicksLabel(50, IMPERIAL)).toBe('200 ft');
    expect(pointingLineTicksLabel(100, IMPERIAL)).toBe('500 ft');
    expect(pointingLineTicksLabel('auto', IMPERIAL)).toBe('Auto');
    expect(pointingLineSummary(DEFAULT_POINTING_LINE)).toBe('500 m along your heading');
    expect(
      pointingLineSummary({ ...DEFAULT_POINTING_LINE, direction: 'course', length: 1000 }),
    ).toBe('1 km along your course');
    expect(
      pointingLineSummary({
        ...DEFAULT_POINTING_LINE,
        direction: 'fixed',
        fixedBearingDeg: 62,
        length: 'edge',
      }),
    ).toBe('To the edge at 062°');
  });

  it('captions the preview', () => {
    expect(pointingLineCaption(DEFAULT_POINTING_LINE, METRIC)).toBe(
      'From you · heading · 500 m · ticks every 50 m',
    );
    expect(
      pointingLineCaption(
        {
          ...DEFAULT_POINTING_LINE,
          direction: 'fixed',
          fixedBearingDeg: 62,
          length: 'edge',
          ticks: 'off',
        },
        METRIC,
      ),
    ).toBe('From you · 062° · to the edge · no ticks');
    expect(
      pointingLineCaption({ ...DEFAULT_POINTING_LINE, direction: 'course', ticks: 'auto' }, METRIC),
    ).toBe('From you · course · 500 m · auto ticks');
    expect(pointingLineCaption(DEFAULT_POINTING_LINE, IMPERIAL)).toBe(
      'From you · heading · 0.5 mi · ticks every 200 ft',
    );
  });

  it('has nine colours, and a casing that never hides the line', () => {
    expect(POINTING_LINE_COLORS).toHaveLength(9);
    expect(new Set(POINTING_LINE_COLORS.map((c) => c.hex)).size).toBe(9);
    expect(pointingLineCasing('#D32F2F')).toBe('#F2ECE0');
    expect(pointingLineCasing('#fbf8f2')).toBe('#2D3740');
  });
});

describe('imperial lengths (2.5.1 final QA)', () => {
  it('reads every stop in round feet and miles, Edge as Edge', () => {
    expect(pointingLineLengthLabels(IMPERIAL)).toEqual([
      '500 ft',
      '1000 ft',
      '0.5 mi',
      '1 mi',
      '2 mi',
      'Edge',
      'Custom',
    ]);
    expect(pointingLineLengthLabels(METRIC)).toEqual([
      '100 m',
      '250 m',
      '500 m',
      '1 km',
      '2 km',
      'Edge',
      'Custom',
    ]);
  });

  it('draws the round imperial distance, keeps the metric one in metric', () => {
    expect(pointingLineLengthM(100, IMPERIAL)).toBeCloseTo(152.4, 6);
    expect(pointingLineLengthM(1000, IMPERIAL)).toBeCloseTo(1609.344, 6);
    expect(pointingLineLengthM(1000, METRIC)).toBe(1000);
    for (const l of [100, 250, 500, 1000, 2000] as const) {
      expect(IMPERIAL_LENGTH_FT[l]).toBeGreaterThan(0);
    }
  });

  it("says the summary and the ground note in the user's units", () => {
    expect(pointingLineSummary(DEFAULT_POINTING_LINE, IMPERIAL)).toBe('0.5 mi along your heading');
    expect(pointingLineLengthText(250, IMPERIAL)).toBe('1000 ft');
    expect(pointingLineGroundNote(500, IMPERIAL)).toMatch(
      /^Drawn on the map, so 0\.5 mi is 0\.5 mi on/,
    );
    expect(pointingLineGroundNote(500, METRIC)).toMatch(/so 500 m is 500 m on/);
    expect(pointingLineGroundNote('edge', METRIC)).toMatch(/so 500 m is 500 m on/);
  });

  it('stores one value: the choice survives a units switch', () => {
    const s = sanitizePointingLine({ ...DEFAULT_POINTING_LINE, length: 250 });
    expect(pointingLineLengthText(s.length, IMPERIAL)).toBe('1000 ft');
    expect(pointingLineLengthText(s.length, METRIC)).toBe('250 m');
  });
});

describe('Custom length (#703)', () => {
  it('persists as the "custom" stop plus metres, sanitised on read', () => {
    expect(DEFAULT_POINTING_LINE.customLengthM).toBe(750);
    const s = sanitizePointingLine({ length: 'custom', customLengthM: 1250 });
    expect(s).toMatchObject({ length: 'custom', customLengthM: 1250 });
    // Junk falls back; out of range clamps.
    expect(sanitizePointingLine({ customLengthM: 'far' }).customLengthM).toBe(750);
    expect(sanitizePointingLine({ customLengthM: -3 }).customLengthM).toBe(750);
    expect(sanitizePointingLine({ customLengthM: 2 }).customLengthM).toBe(CUSTOM_LENGTH_MIN_M);
    expect(sanitizePointingLine({ customLengthM: 1e7 }).customLengthM).toBe(CUSTOM_LENGTH_MAX_M);
    // A pre-#703 file (no customLengthM) keeps its preset.
    expect(sanitizePointingLine({ length: 1000 })).toMatchObject({
      length: 1000,
      customLengthM: 750,
    });
  });

  it('clamps to 10 m … 50 km', () => {
    expect(clampCustomLengthM(5)).toBe(10);
    expect(clampCustomLengthM(123.4)).toBe(123.4);
    expect(clampCustomLengthM(60_000)).toBe(50_000);
    expect(clampCustomLengthM(0)).toBeNull();
    expect(clampCustomLengthM(NaN)).toBeNull();
    expect(clampCustomLengthM(Infinity)).toBeNull();
  });

  it('parses typed text in metres, or feet in imperial', () => {
    expect(parseCustomLength('1250', METRIC)).toBe(1250);
    expect(parseCustomLength(' 12.5 ', METRIC)).toBe(12.5);
    expect(parseCustomLength('12,5', METRIC)).toBe(12.5);
    expect(parseCustomLength('1500', IMPERIAL)).toBeCloseTo(457.2, 9);
    expect(parseCustomLength('', METRIC)).toBeNull();
    expect(parseCustomLength('.', METRIC)).toBeNull();
    expect(parseCustomLength('1.2.3', METRIC)).toBeNull();
    expect(parseCustomLength('-5', METRIC)).toBeNull();
    expect(parseCustomLength('0', METRIC)).toBeNull();
    expect(parseCustomLength('3', METRIC)).toBe(10);
  });

  it('types Custom in the ruler’s short unit (#702): NM takes the elevation unit', () => {
    expect(customLengthInputUnit(METRIC)).toBe('m');
    expect(customLengthInputUnit(IMPERIAL)).toBe('ft');
    expect(customLengthInputUnit(NAUTICAL)).toBe('m');
    const nmFt = { distance: 'nmi', elevation: 'ft' } as const;
    expect(customLengthInputUnit(nmFt)).toBe('ft');
    expect(parseCustomLength('1500', nmFt)).toBeCloseTo(457.2, 9);
    expect(pointingLineLengthText('custom', NAUTICAL, 1250)).toBe('1.25 km');
    expect(pointingLineLengthText('custom', nmFt, 457.2)).toBe('1500 ft');
  });

  it('shows the stored metres back in the input unit, whole', () => {
    expect(customLengthInputText(1250, METRIC)).toBe('1250');
    expect(customLengthInputText(457.2, IMPERIAL)).toBe('1500');
    expect(customLengthInputText(12.6, METRIC)).toBe('13');
  });

  it('reads as a distance in summaries, captions and the note', () => {
    const s = { ...DEFAULT_POINTING_LINE, length: 'custom' as const, customLengthM: 1250 };
    expect(pointingLineSummary(s)).toBe('1.25 km along your heading');
    expect(pointingLineCaption(s, METRIC)).toBe('From you · heading · 1.25 km · ticks every 50 m');
    expect(pointingLineLengthText('custom', METRIC, 640)).toBe('640 m');
    expect(pointingLineLengthText('custom', IMPERIAL, 457.2)).toBe('1500 ft');
    expect(pointingLineLengthText('custom', IMPERIAL, 3218.688)).toBe('2 mi');
    expect(pointingLineGroundNote('custom', METRIC, 640)).toMatch(/so 640 m is 640 m on/);
  });

  it('draws the typed metres; Edge has none', () => {
    expect(pointingLineChoiceM('custom', IMPERIAL, 1250)).toBe(1250);
    expect(pointingLineChoiceM(500, METRIC, 1250)).toBe(500);
    expect(pointingLineChoiceM('edge', METRIC, 1250)).toBeNull();
  });
});
