import type { TrackPoint } from '@core/models';

import {
  appleLocationToPoint,
  appleWorkoutPauses,
  classifyHealthConnectRoute,
  healthConnectLocationToPoint,
  healthConnectRouteToActivityRoute,
  quantityToMetres,
  stitchRoutes,
  toEpochMs,
} from './routes';

const T0 = Date.UTC(2026, 8, 12, 14, 0, 0);

describe('toEpochMs', () => {
  it('reads Dates, numbers and ISO strings', () => {
    expect(toEpochMs(new Date(T0))).toBe(T0);
    expect(toEpochMs(T0)).toBe(T0);
    expect(toEpochMs(new Date(T0).toISOString())).toBe(T0);
    expect(toEpochMs(undefined)).toBeNaN();
    expect(toEpochMs(null)).toBeNaN();
  });
});

describe('appleLocationToPoint', () => {
  const loc = {
    latitude: 46.81,
    longitude: -71.21,
    altitude: 98.5,
    date: new Date(T0),
    horizontalAccuracy: 4,
    verticalAccuracy: 3,
    speed: 2.5,
  };

  it('maps every field', () => {
    expect(appleLocationToPoint(loc)).toEqual({
      latitude: 46.81,
      longitude: -71.21,
      altitude: 98.5,
      altitudeAccuracy: 3,
      time: T0,
      accuracy: 4,
      speed: 2.5,
    });
  });

  it('drops CoreLocation invalid markers', () => {
    const p = appleLocationToPoint({ ...loc, verticalAccuracy: -1, speed: -1 });
    expect(p).toEqual({ latitude: 46.81, longitude: -71.21, time: T0, accuracy: 4 });
  });

  it('keeps altitude when vertical accuracy is not reported', () => {
    const p = appleLocationToPoint({ ...loc, verticalAccuracy: undefined });
    expect(p?.altitude).toBe(98.5);
    expect(p?.altitudeAccuracy).toBeUndefined();
  });

  it('rejects fixes without a position or time', () => {
    expect(appleLocationToPoint({ ...loc, horizontalAccuracy: -1 })).toBeNull();
    expect(appleLocationToPoint({ ...loc, latitude: 91 })).toBeNull();
    expect(appleLocationToPoint({ ...loc, latitude: 0, longitude: 0 })).toBeNull();
    expect(appleLocationToPoint({ ...loc, longitude: Number.NaN })).toBeNull();
    expect(appleLocationToPoint({ ...loc, date: 'nope' })).toBeNull();
  });
});

describe('appleWorkoutPauses', () => {
  it('pairs pause and resume events in time order', () => {
    const events = [
      { type: 2, startDate: new Date(T0 + 200) },
      { type: 1, startDate: new Date(T0 + 100) },
      { type: 5, startDate: new Date(T0 + 300) }, // motion pause: ignored
      { type: 1, startDate: new Date(T0 + 400) },
      { type: 1, startDate: new Date(T0 + 450) }, // double pause: first wins
      { type: 2, startDate: new Date(T0 + 500) },
      { type: 1, startDate: new Date(T0 + 900) }, // never resumed
    ];
    expect(appleWorkoutPauses(events)).toEqual([
      { from: T0 + 100, to: T0 + 200 },
      { from: T0 + 400, to: T0 + 500 },
    ]);
  });

  it('ignores stray resumes, bad dates and a missing list', () => {
    expect(appleWorkoutPauses([{ type: 2, startDate: T0 }])).toEqual([]);
    expect(appleWorkoutPauses([{ type: 1, startDate: 'x' }])).toEqual([]);
    expect(appleWorkoutPauses(undefined)).toEqual([]);
  });
});

describe('quantityToMetres', () => {
  it('converts known units', () => {
    expect(quantityToMetres({ quantity: 1234, unit: 'meters' })).toBe(1234);
    expect(quantityToMetres({ quantity: 2, unit: 'km' })).toBe(2000);
    expect(quantityToMetres({ quantity: 1, unit: 'mi' })).toBeCloseTo(1609.344);
  });

  it('is 0 for missing, unknown or invalid quantities', () => {
    expect(quantityToMetres(undefined)).toBe(0);
    expect(quantityToMetres({ quantity: 5, unit: 'furlong' })).toBe(0);
    expect(quantityToMetres({ quantity: Number.NaN, unit: 'm' })).toBe(0);
    expect(quantityToMetres({ quantity: -3, unit: 'm' })).toBe(0);
  });
});

const pt = (t: number): TrackPoint => ({ latitude: 46.8, longitude: -71.2, time: T0 + t });

describe('stitchRoutes', () => {
  it('concatenates routes in time order with a segment per route', () => {
    const r = stitchRoutes([[pt(50), pt(60)], [], [pt(10), pt(0), pt(20)]]);
    expect(r.points.map((p) => p.time - T0)).toEqual([0, 10, 20, 50, 60]);
    expect(r.segmentStarts).toEqual([3]);
  });

  it('adds pause boundaries and dedupes them with route boundaries', () => {
    const r = stitchRoutes(
      [
        [pt(0), pt(10), pt(30)],
        [pt(100), pt(110)],
      ],
      [
        { from: T0 + 15, to: T0 + 25 },
        { from: T0 + 50, to: T0 + 90 },
      ],
    );
    expect(r.segmentStarts).toEqual([2, 3]);
  });

  it('is empty for no routes', () => {
    expect(stitchRoutes([])).toEqual({ points: [], segmentStarts: [] });
  });
});

describe('classifyHealthConnectRoute', () => {
  it('reads the string states the native side sends', () => {
    expect(classifyHealthConnectRoute({ type: 'DATA', route: [] })).toBe('data');
    expect(classifyHealthConnectRoute({ type: 'NO_DATA', route: [] })).toBe('no-data');
    expect(classifyHealthConnectRoute({ type: 'CONSENT_REQUIRED' })).toBe('consent-required');
  });

  it('reads the numeric enum too', () => {
    expect(classifyHealthConnectRoute({ type: 0 })).toBe('data');
    expect(classifyHealthConnectRoute({ type: 1 })).toBe('no-data');
    expect(classifyHealthConnectRoute({ type: 2 })).toBe('consent-required');
  });

  it('is unknown for anything else', () => {
    expect(classifyHealthConnectRoute(undefined)).toBe('unknown');
    expect(classifyHealthConnectRoute('DATA')).toBe('unknown');
    expect(classifyHealthConnectRoute({ type: 'WHAT' })).toBe('unknown');
  });
});

describe('healthConnectLocationToPoint', () => {
  const iso = new Date(T0).toISOString();

  it('maps a full location', () => {
    expect(
      healthConnectLocationToPoint({
        time: iso,
        latitude: 46.8,
        longitude: -71.2,
        altitude: { inMeters: 120 },
        horizontalAccuracy: { inMeters: 5 },
        verticalAccuracy: { inMeters: 8 },
      }),
    ).toEqual({
      latitude: 46.8,
      longitude: -71.2,
      time: T0,
      altitude: 120,
      altitudeAccuracy: 8,
      accuracy: 5,
    });
  });

  it('treats the all-zero Length the library sends for "absent" as missing', () => {
    expect(
      healthConnectLocationToPoint({
        time: iso,
        latitude: 46.8,
        longitude: -71.2,
        altitude: { inMeters: 0 },
        horizontalAccuracy: { inMeters: 0 },
        verticalAccuracy: null,
      }),
    ).toEqual({ latitude: 46.8, longitude: -71.2, time: T0 });
  });

  it('rejects bad positions and times', () => {
    expect(healthConnectLocationToPoint({ time: 'x', latitude: 1, longitude: 1 })).toBeNull();
    expect(healthConnectLocationToPoint({ time: iso, latitude: 0, longitude: 0 })).toBeNull();
  });
});

describe('healthConnectRouteToActivityRoute', () => {
  it('keeps valid points in time order as one segment', () => {
    const later = new Date(T0 + 1000).toISOString();
    const r = healthConnectRouteToActivityRoute([
      { time: later, latitude: 46.81, longitude: -71.21 },
      { time: 'bad', latitude: 46.8, longitude: -71.2 },
      { time: new Date(T0).toISOString(), latitude: 46.8, longitude: -71.2 },
    ]);
    expect(r.points.map((p) => p.time)).toEqual([T0, T0 + 1000]);
    expect(r.segmentStarts).toEqual([]);
  });

  it('is empty for a missing route', () => {
    expect(healthConnectRouteToActivityRoute(undefined).points).toEqual([]);
  });
});
