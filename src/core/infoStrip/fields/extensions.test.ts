import { formatClockTime } from '@core/format';

import { IMPERIAL, METRIC, NOW, snapshot } from '../testUtils';
import { NEAREST_STATION, type GnssSnapshot, type TideSnapshot } from '../types';
import { LIVE_MAX_AGE_MS } from '@core/tides/live';

import { GNSS_FIX, GNSS_HEIGHT, levelIsLive, TIDE_LEVEL, TIDE_NEXT_HIGH } from './extensions';

const RTK: GnssSnapshot = { kind: 'rtk-fixed', ellipsoidalHeightM: 183.4231, heightAccuracyM: 0.4 };
const TIDE: TideSnapshot = {
  stationName: 'Lauzon',
  levelM: 3.842,
  levelAtMs: NOW - 6 * 60_000,
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
  const NEAREST = { station: NEAREST_STATION };
  const at = (t: TideSnapshot) => snapshot({ tides: { [NEAREST_STATION]: t } });

  it('the level at the station, signed, with its trend', () => {
    expect(TIDE_LEVEL.compute(at(TIDE), NEAREST, METRIC)).toEqual({
      glyph: 'waves',
      tag: 'Lauzon',
      value: '+3.84',
      unit: 'm ↑',
    });
    const falling = { ...TIDE, levelM: -0.31, trend: 'falling' as const };
    expect(TIDE_LEVEL.compute(at(falling), NEAREST, METRIC)).toMatchObject({
      value: '−0.31',
      unit: 'm ↓',
    });
    const slack = { ...TIDE, trend: null };
    expect(TIDE_LEVEL.compute(at(slack), NEAREST, METRIC)?.unit).toBe('m');
    expect(TIDE_LEVEL.compute(snapshot(), NEAREST, METRIC)).toBeNull();
    // A height: the elevation unit (#702).
    expect(TIDE_LEVEL.compute(at(TIDE), NEAREST, IMPERIAL)).toMatchObject({
      value: '+12.60',
      unit: 'ft ↑',
    });
    // No fresh observation: no level (the next high may still show).
    expect(TIDE_LEVEL.compute(at({ ...TIDE, levelM: null }), NEAREST, METRIC)).toBeNull();
  });

  it('an observation older than the live limit is not "now": the level steps aside', () => {
    const edge = { ...TIDE, levelAtMs: NOW - LIVE_MAX_AGE_MS };
    expect(levelIsLive(edge, NOW)).toBe(true);
    expect(TIDE_LEVEL.compute(at(edge), NEAREST, METRIC)).not.toBeNull();
    const stale = { ...TIDE, levelAtMs: NOW - LIVE_MAX_AGE_MS - 1 };
    expect(levelIsLive(stale, NOW)).toBe(false);
    expect(TIDE_LEVEL.compute(at(stale), NEAREST, METRIC)).toBeNull();
    // The same snapshot, read on a later minute tick, goes stale on its own.
    expect(TIDE_LEVEL.compute(at(TIDE), NEAREST, METRIC)).not.toBeNull();
    const later = snapshot({ nowMs: NOW + LIVE_MAX_AGE_MS, tides: { [NEAREST_STATION]: TIDE } });
    expect(TIDE_LEVEL.compute(later, NEAREST, METRIC)).toBeNull();
    // A level without a time is never "now"; the next high is a prediction and stays.
    const untimed = { ...TIDE, levelAtMs: null };
    expect(TIDE_LEVEL.compute(at(untimed), NEAREST, METRIC)).toBeNull();
    expect(TIDE_NEXT_HIGH.compute(at(stale), NEAREST, METRIC)).not.toBeNull();
  });

  it('reads the station its param names, not another', () => {
    const picked = { station: '100:03250' };
    const data = snapshot({ tides: { '100:03250': { ...TIDE, stationName: 'Rimouski' } } });
    expect(TIDE_LEVEL.compute(data, picked, METRIC)?.tag).toBe('Rimouski');
    expect(TIDE_LEVEL.compute(data, NEAREST, METRIC)).toBeNull();
    expect(TIDE_NEXT_HIGH.compute(data, picked, METRIC)).not.toBeNull();
  });

  it('the next high tide, clock time, until it has passed', () => {
    expect(TIDE_NEXT_HIGH.compute(at(TIDE), NEAREST, METRIC)).toEqual({
      tag: 'High',
      value: formatClockTime(NOW + 3 * 3600_000),
    });
    expect(TIDE_NEXT_HIGH.compute(at({ ...TIDE, nextHigh: null }), NEAREST, METRIC)).toBeNull();
    const passed = { ...TIDE, nextHigh: { atMs: NOW - 60_000, levelM: 5.1 } };
    expect(TIDE_NEXT_HIGH.compute(at(passed), NEAREST, METRIC)).toBeNull();
    expect(TIDE_NEXT_HIGH.compute(snapshot(), NEAREST, METRIC)).toBeNull();
  });

  it('refresh each minute, never faster, and default to the nearest station', () => {
    for (const d of [TIDE_LEVEL, TIDE_NEXT_HIGH]) {
      expect(d.tick).toBe('minute');
      expect(d.defaults).toEqual({ station: NEAREST_STATION });
      expect(d.params.station.kind).toBe('station');
    }
  });
});
