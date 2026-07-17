import {
  LAST_POSITION_WRITE_INTERVAL_MS,
  resolveInitialCenter,
  sanitizeLastKnownPosition,
  shouldPersistPosition,
} from './lastKnownPosition';

describe('sanitizeLastKnownPosition', () => {
  it('accepts a valid coordinate pair', () => {
    expect(sanitizeLastKnownPosition({ latitude: 46.81, longitude: -71.21 })).toEqual({
      latitude: 46.81,
      longitude: -71.21,
    });
  });

  it('drops unknown extra fields', () => {
    expect(
      sanitizeLastKnownPosition({ latitude: 1, longitude: 2, altitude: 300, junk: 'x' }),
    ).toEqual({ latitude: 1, longitude: 2 });
  });

  it('accepts the range edges (poles and the antimeridian)', () => {
    expect(sanitizeLastKnownPosition({ latitude: 90, longitude: 180 })).toEqual({
      latitude: 90,
      longitude: 180,
    });
    expect(sanitizeLastKnownPosition({ latitude: -90, longitude: -180 })).toEqual({
      latitude: -90,
      longitude: -180,
    });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'lat,lng'],
    ['a number', 42],
    ['an array', [46.81, -71.21]],
    ['an empty object', {}],
    ['a missing longitude', { latitude: 46.81 }],
    ['a string latitude', { latitude: '46.81', longitude: -71.21 }],
    ['a NaN latitude', { latitude: NaN, longitude: -71.21 }],
    ['an Infinity longitude', { latitude: 46.81, longitude: Infinity }],
    ['an out-of-range latitude', { latitude: 91, longitude: 0 }],
    ['an out-of-range longitude', { latitude: 0, longitude: -180.5 }],
  ])('rejects %s', (_label, value) => {
    expect(sanitizeLastKnownPosition(value)).toBeNull();
  });
});

describe('resolveInitialCenter', () => {
  const live = { latitude: 1, longitude: 2 };
  const persisted = { latitude: 3, longitude: 4 };

  it('prefers the live fix and returns [lng, lat]', () => {
    expect(resolveInitialCenter(live, persisted)).toEqual([2, 1]);
  });

  it('falls back to the persisted position without a live fix', () => {
    expect(resolveInitialCenter(null, persisted)).toEqual([4, 3]);
  });

  it('returns null with neither (MapLibre default)', () => {
    expect(resolveInitialCenter(null, null)).toBeNull();
  });
});

describe('shouldPersistPosition', () => {
  it('persists when never written this session', () => {
    expect(shouldPersistPosition(null, 12345)).toBe(true);
  });

  it('skips within the throttle interval', () => {
    expect(shouldPersistPosition(1000, 1000 + LAST_POSITION_WRITE_INTERVAL_MS - 1)).toBe(false);
  });

  it('persists once the interval has elapsed', () => {
    expect(shouldPersistPosition(1000, 1000 + LAST_POSITION_WRITE_INTERVAL_MS)).toBe(true);
  });

  it('honours a custom interval', () => {
    expect(shouldPersistPosition(1000, 1500, 1000)).toBe(false);
    expect(shouldPersistPosition(1000, 2000, 1000)).toBe(true);
  });
});
