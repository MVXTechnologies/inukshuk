import { formatClockTime } from '@core/format';

import { METRIC, NOW, snapshot } from '../testUtils';
import type { GnssSnapshot, TideSnapshot } from '../types';
import { GNSS_FIX, GNSS_HEIGHT, TIDE_LEVEL, TIDE_NEXT_HIGH } from './extensions';

const RTK: GnssSnapshot = { kind: 'rtk-fixed', ellipsoidalHeightM: 183.4231, heightAccuracyM: 0.4 };
const TIDE: TideSnapshot = {
  stationName: 'Lauzon',
  levelM: 3.842,
  trend: 'rising',
  nextHigh: { atMs: NOW + 3 * 3600_000, levelM: 5.1 },
};

describe('GNSS fields', () => {
  it('ellipsoidal height, with the decimals its accuracy supports', () => {
    expect(GNSS_HEIGHT.compute(snapshot({ gnss: RTK }), {}, METRIC)).toEqual({
      tag: 'h',
      value: '183.42',
      unit: 'm',
    });
    expect(
      GNSS_HEIGHT.compute(snapshot({ gnss: { ...RTK, ellipsoidalHeightM: null } }), {}, METRIC),
    ).toBeNull();
    expect(GNSS_HEIGHT.compute(snapshot(), {}, METRIC)).toBeNull();
  });

  it('the fix: sage when fixed, amber with none', () => {
    expect(GNSS_FIX.compute(snapshot({ gnss: RTK }), {}, METRIC)).toEqual({
      glyph: 'satellite_alt',
      value: 'RTK fixed',
      tone: 'ok',
    });
    expect(GNSS_FIX.compute(snapshot({ gnss: { ...RTK, kind: 'rtk-float' } }), {}, METRIC)).toEqual(
      { glyph: 'satellite_alt', value: 'RTK float' },
    );
    expect(GNSS_FIX.compute(snapshot({ gnss: { ...RTK, kind: 'none' } }), {}, METRIC)?.tone).toBe(
      'warn',
    );
    expect(GNSS_FIX.compute(snapshot(), {}, METRIC)).toBeNull();
  });
});

describe('tide fields', () => {
  it('the level at the station, signed, with its trend', () => {
    expect(TIDE_LEVEL.compute(snapshot({ tides: TIDE }), {}, METRIC)).toEqual({
      glyph: 'waves',
      tag: 'Lauzon',
      value: '+3.84',
      unit: 'm ↑',
    });
    const falling = { ...TIDE, levelM: -0.31, trend: 'falling' as const };
    expect(TIDE_LEVEL.compute(snapshot({ tides: falling }), {}, METRIC)).toMatchObject({
      value: '−0.31',
      unit: 'm ↓',
    });
    const slack = { ...TIDE, trend: null };
    expect(TIDE_LEVEL.compute(snapshot({ tides: slack }), {}, METRIC)?.unit).toBe('m');
    expect(TIDE_LEVEL.compute(snapshot(), {}, METRIC)).toBeNull();
  });

  it('the next high tide, clock time', () => {
    expect(TIDE_NEXT_HIGH.compute(snapshot({ tides: TIDE }), {}, METRIC)).toEqual({
      tag: 'High',
      value: formatClockTime(NOW + 3 * 3600_000),
    });
    expect(
      TIDE_NEXT_HIGH.compute(snapshot({ tides: { ...TIDE, nextHigh: null } }), {}, METRIC),
    ).toBeNull();
    expect(TIDE_NEXT_HIGH.compute(snapshot(), {}, METRIC)).toBeNull();
  });
});
