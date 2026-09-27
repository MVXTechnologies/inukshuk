import {
  autoNightDismissalEnd,
  DISPLAY_CONDITIONS,
  effectiveCondition,
  isAfterDark,
  isDisplayCondition,
  type DisplayInputs,
} from './condition';

const H = 3_600_000;
const DAY_START = Date.UTC(2026, 8, 27, 0); // arbitrary midnight
const SUN = { sunrise: DAY_START + 6 * H, sunset: DAY_START + 19 * H };

function inputs(over: Partial<DisplayInputs> = {}): DisplayInputs {
  return {
    chosen: 'normal',
    autoNightAtSunset: false,
    sunlightWhileRecording: false,
    recording: false,
    now: DAY_START + 12 * H,
    sun: SUN,
    autoNightDismissedUntil: null,
    ...over,
  };
}

describe('isDisplayCondition', () => {
  it('accepts the three modes only', () => {
    for (const c of DISPLAY_CONDITIONS) expect(isDisplayCondition(c)).toBe(true);
    expect(isDisplayCondition('dark')).toBe(false);
    expect(isDisplayCondition(undefined)).toBe(false);
  });
});

describe('isAfterDark', () => {
  it('is dark after sunset and before sunrise', () => {
    expect(isAfterDark(DAY_START + 20 * H, SUN)).toBe(true);
    expect(isAfterDark(DAY_START + 5 * H, SUN)).toBe(true);
    expect(isAfterDark(DAY_START + 12 * H, SUN)).toBe(false);
  });

  it('never claims dark without sun times (polar day/night, no position)', () => {
    expect(isAfterDark(DAY_START + 23 * H, null)).toBe(false);
    expect(isAfterDark(DAY_START + 23 * H, { sunrise: null, sunset: null })).toBe(false);
  });
});

describe('effectiveCondition (decision 4: opt-in, never automatic by default)', () => {
  it('stays Normal at night and while recording when no toggle is on', () => {
    expect(effectiveCondition(inputs({ now: DAY_START + 22 * H, recording: true }))).toBe('normal');
  });

  it('honours an explicit Sunlight or Night choice at any time', () => {
    expect(effectiveCondition(inputs({ chosen: 'night' }))).toBe('night');
    expect(effectiveCondition(inputs({ chosen: 'sunlight', now: DAY_START + 22 * H }))).toBe(
      'sunlight',
    );
  });

  it('switches to Night after sunset with the auto toggle', () => {
    expect(effectiveCondition(inputs({ autoNightAtSunset: true }))).toBe('normal');
    expect(effectiveCondition(inputs({ autoNightAtSunset: true, now: DAY_START + 20 * H }))).toBe(
      'night',
    );
  });

  it('lets "tap to exit" silence auto night until the dismissal ends', () => {
    const late = DAY_START + 20 * H;
    expect(
      effectiveCondition(
        inputs({ autoNightAtSunset: true, now: late, autoNightDismissedUntil: late + H }),
      ),
    ).toBe('normal');
    expect(
      effectiveCondition(
        inputs({ autoNightAtSunset: true, now: late + 2 * H, autoNightDismissedUntil: late + H }),
      ),
    ).toBe('night');
  });

  it('switches to Sunlight while recording with its toggle', () => {
    expect(effectiveCondition(inputs({ sunlightWhileRecording: true }))).toBe('normal');
    expect(effectiveCondition(inputs({ sunlightWhileRecording: true, recording: true }))).toBe(
      'sunlight',
    );
  });

  it('prefers Night over Sunlight when both toggles apply after dark', () => {
    expect(
      effectiveCondition(
        inputs({
          autoNightAtSunset: true,
          sunlightWhileRecording: true,
          recording: true,
          now: DAY_START + 21 * H,
        }),
      ),
    ).toBe('night');
  });
});

describe('autoNightDismissalEnd', () => {
  it('lasts until the next sunrise', () => {
    expect(autoNightDismissalEnd(DAY_START + 3 * H, SUN)).toBe(SUN.sunrise);
    expect(autoNightDismissalEnd(DAY_START + 20 * H, SUN)).toBe(SUN.sunrise + 24 * H);
  });

  it('falls back to twelve hours without sun times', () => {
    expect(autoNightDismissalEnd(DAY_START, null)).toBe(DAY_START + 12 * H);
  });
});
