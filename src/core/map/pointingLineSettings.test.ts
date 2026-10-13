import {
  DEFAULT_POINTING_LINE,
  POINTING_LINE_COLORS,
  formatFixedBearing,
  parseBearing,
  pointingLineCaption,
  pointingLineCasing,
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
    expect(pointingLineTicksLabel('off', 'metric')).toBe('Off');
    expect(pointingLineTicksLabel(10, 'metric')).toBe('10 m');
    expect(pointingLineTicksLabel('auto', 'metric')).toBe('Auto');
    // Imperial: the round-feet step each choice stands for.
    expect(pointingLineTicksLabel('off', 'imperial')).toBe('Off');
    expect(pointingLineTicksLabel(10, 'imperial')).toBe('50 ft');
    expect(pointingLineTicksLabel(50, 'imperial')).toBe('200 ft');
    expect(pointingLineTicksLabel(100, 'imperial')).toBe('500 ft');
    expect(pointingLineTicksLabel('auto', 'imperial')).toBe('Auto');
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
    expect(pointingLineCaption(DEFAULT_POINTING_LINE, 'metric')).toBe(
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
        'metric',
      ),
    ).toBe('From you · 062° · to the edge · no ticks');
    expect(
      pointingLineCaption(
        { ...DEFAULT_POINTING_LINE, direction: 'course', ticks: 'auto' },
        'metric',
      ),
    ).toBe('From you · course · 500 m · auto ticks');
    expect(pointingLineCaption(DEFAULT_POINTING_LINE, 'imperial')).toBe(
      'From you · heading · 500 m · ticks every 200 ft',
    );
  });

  it('has nine colours, and a casing that never hides the line', () => {
    expect(POINTING_LINE_COLORS).toHaveLength(9);
    expect(new Set(POINTING_LINE_COLORS.map((c) => c.hex)).size).toBe(9);
    expect(pointingLineCasing('#D32F2F')).toBe('#F2ECE0');
    expect(pointingLineCasing('#fbf8f2')).toBe('#2D3740');
  });
});
