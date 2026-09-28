import * as HealthKit from '@kingstinct/react-native-healthkit';

import {
  appleHealthAvailable,
  appleHealthSource,
  requestAppleHealthPermissions,
} from './appleHealth';

jest.mock('@kingstinct/react-native-healthkit', () => ({
  WorkoutTypeIdentifier: 'HKWorkoutTypeIdentifier',
  WorkoutRouteTypeIdentifier: 'HKWorkoutRouteTypeIdentifier',
  isHealthDataAvailable: jest.fn(() => true),
  requestAuthorization: jest.fn(async () => true),
  queryWorkoutSamples: jest.fn(async () => []),
}));

const hk = jest.mocked(HealthKit);
const signal = new AbortController().signal;
const T0 = Date.UTC(2026, 8, 12, 14, 0, 0);

function workout(over: Record<string, unknown> = {}) {
  return {
    uuid: 'W1',
    workoutActivityType: 24, // hiking
    startDate: new Date(T0),
    totalDistance: { quantity: 5400, unit: 'meters' },
    metadata: {},
    events: [],
    dispose: jest.fn(),
    getWorkoutRoutes: jest.fn(async () => []),
    ...over,
  };
}

function loc(t: number, lat = 46.8) {
  return {
    latitude: lat,
    longitude: -71.2,
    altitude: 100,
    date: new Date(T0 + t),
    horizontalAccuracy: 5,
    verticalAccuracy: 4,
    speed: 1.2,
    course: 0,
    speedAccuracy: 0.5,
  };
}

describe('appleHealth permissions', () => {
  it('asks to read workouts and routes only', async () => {
    await expect(requestAppleHealthPermissions()).resolves.toBe('granted');
    expect(hk.requestAuthorization).toHaveBeenCalledWith({
      toRead: ['HKWorkoutTypeIdentifier', 'HKWorkoutRouteTypeIdentifier'],
    });
  });

  it('is denied when HealthKit refuses or is missing', async () => {
    hk.requestAuthorization.mockRejectedValueOnce(new Error('nope'));
    await expect(requestAppleHealthPermissions()).resolves.toBe('denied');
    hk.requestAuthorization.mockResolvedValueOnce(false);
    await expect(requestAppleHealthPermissions()).resolves.toBe('denied');
    hk.isHealthDataAvailable.mockReturnValueOnce(false);
    await expect(requestAppleHealthPermissions()).resolves.toBe('denied');
  });

  it('reports unavailable when the check throws', () => {
    hk.isHealthDataAvailable.mockImplementationOnce(() => {
      throw new Error('no');
    });
    expect(appleHealthAvailable()).toBe(false);
  });
});

describe('appleHealthSource.list', () => {
  it('maps workouts newest first and disposes the proxies', async () => {
    const older = workout({ uuid: 'OLD', startDate: new Date(T0 - 86_400_000) });
    const indoor = workout({
      uuid: 'TREAD',
      workoutActivityType: 37,
      startDate: new Date(T0 + 1000),
      totalDistance: undefined,
      metadata: { HKIndoorWorkout: true },
    });
    const hike = workout();
    hk.queryWorkoutSamples.mockResolvedValueOnce([older, hike, indoor] as never);

    const list = await appleHealthSource.list(T0 - 86_400_000, signal);

    expect(hk.queryWorkoutSamples).toHaveBeenCalledWith({
      limit: 0,
      ascending: false,
      filter: { date: { startDate: new Date(T0 - 86_400_000), strictStartDate: true } },
    });
    expect(list).toEqual([
      {
        origin: { source: 'apple-health', externalId: 'TREAD' },
        category: 'run',
        sportLabel: 'Run',
        startedAt: T0 + 1000,
        distanceM: 0,
        hasRoute: false,
      },
      {
        origin: { source: 'apple-health', externalId: 'W1' },
        category: 'hike',
        sportLabel: 'Hike',
        startedAt: T0,
        distanceM: 5400,
        hasRoute: true,
      },
      expect.objectContaining({ origin: { source: 'apple-health', externalId: 'OLD' } }),
    ]);
    for (const w of [older, hike, indoor]) expect(w.dispose).toHaveBeenCalled();
  });

  it('drops workouts that started before `since`', async () => {
    hk.queryWorkoutSamples.mockResolvedValueOnce([workout()] as never);
    await expect(appleHealthSource.list(T0 + 1, signal)).resolves.toEqual([]);
  });

  it('honours an aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(appleHealthSource.list(0, ac.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('appleHealthSource.fetchRoute', () => {
  const activity = {
    origin: { source: 'apple-health' as const, externalId: 'W1' },
    startedAt: T0,
    distanceM: 0,
    hasRoute: true,
  };

  it('stitches every route of the workout, splitting at boundaries and pauses', async () => {
    const w = workout({
      events: [
        { type: 1, startDate: new Date(T0 + 15_000) },
        { type: 2, startDate: new Date(T0 + 25_000) },
      ],
      getWorkoutRoutes: jest.fn(async () => [
        { locations: [loc(100_000), loc(110_000)] },
        {
          locations: [loc(0), loc(10_000), loc(30_000), { ...loc(40_000), horizontalAccuracy: -1 }],
        },
      ]),
    });
    hk.queryWorkoutSamples.mockResolvedValueOnce([w] as never);

    const route = await appleHealthSource.fetchRoute(activity, signal, jest.fn());

    expect(hk.queryWorkoutSamples).toHaveBeenCalledWith({ limit: 1, filter: { uuid: 'W1' } });
    expect(route.points.map((p) => p.time - T0)).toEqual([0, 10_000, 30_000, 100_000, 110_000]);
    expect(route.segmentStarts).toEqual([2, 3]);
    expect(route.points[0]).toMatchObject({ accuracy: 5, altitude: 100, speed: 1.2 });
    expect(w.dispose).toHaveBeenCalled();
  });

  it('is empty when the workout is gone', async () => {
    hk.queryWorkoutSamples.mockResolvedValueOnce([]);
    await expect(appleHealthSource.fetchRoute(activity, signal, jest.fn())).resolves.toEqual({
      points: [],
      segmentStarts: [],
    });
  });

  it('disposes the workout even when the route read fails', async () => {
    const w = workout({
      getWorkoutRoutes: jest.fn(async () => {
        throw new Error('HK');
      }),
    });
    hk.queryWorkoutSamples.mockResolvedValueOnce([w] as never);
    await expect(appleHealthSource.fetchRoute(activity, signal, jest.fn())).rejects.toThrow('HK');
    expect(w.dispose).toHaveBeenCalled();
  });
});
