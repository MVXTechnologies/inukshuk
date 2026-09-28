import { Linking, Platform } from 'react-native';
import * as HC from 'react-native-health-connect';

import {
  healthConnectAvailabilityNow,
  healthConnectSource,
  healthConnectSupportedOs,
  openHealthConnectInstall,
  requestHealthConnectPermissions,
  resetHealthConnectForTests,
} from './healthConnect';

jest.mock('react-native-health-connect', () => ({
  getSdkStatus: jest.fn(async () => 3),
  initialize: jest.fn(async () => true),
  requestPermission: jest.fn(async () => []),
  getGrantedPermissions: jest.fn(async () => []),
  readRecords: jest.fn(async () => ({ records: [] })),
  readRecord: jest.fn(),
  aggregateRecord: jest.fn(),
  requestExerciseRoute: jest.fn(),
}));

const hc = jest.mocked(HC);
const signal = new AbortController().signal;
const T0 = Date.UTC(2026, 8, 12, 14, 0, 0);
const iso = (t: number) => new Date(T0 + t).toISOString();

const EX = { accessType: 'read', recordType: 'ExerciseSession' } as const;
const DIST = { accessType: 'read', recordType: 'Distance' } as const;
const HIST = { accessType: 'read', recordType: 'ReadHealthDataHistory' } as const;

const originalOS = Platform.OS;
const originalVersion = Platform.Version;

function setPlatform(os: string, version: number) {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
  Object.defineProperty(Platform, 'Version', { value: version, configurable: true });
}

beforeEach(() => {
  resetHealthConnectForTests();
  setPlatform('android', 34);
});

afterAll(() => {
  Object.defineProperty(Platform, 'OS', { value: originalOS, configurable: true });
  Object.defineProperty(Platform, 'Version', { value: originalVersion, configurable: true });
});

function session(id: string, t: number, over: Record<string, unknown> = {}) {
  return {
    startTime: iso(t),
    endTime: iso(t + 3_600_000),
    exerciseType: 37, // hiking
    title: undefined,
    exerciseRoute: { type: 'CONSENT_REQUIRED', route: [] },
    metadata: { id },
    ...over,
  };
}

const hcLoc = (t: number) => ({
  time: iso(t),
  latitude: 46.8,
  longitude: -71.2,
  altitude: { inMeters: 110 },
  horizontalAccuracy: { inMeters: 6 },
  verticalAccuracy: { inMeters: 0 },
});

describe('availability', () => {
  it('needs Android 9+', async () => {
    setPlatform('android', 27);
    expect(healthConnectSupportedOs()).toBe(false);
    await expect(healthConnectAvailabilityNow()).resolves.toBe('unavailable');
    expect(hc.getSdkStatus).not.toHaveBeenCalled();
  });

  it('maps the SDK status', async () => {
    hc.getSdkStatus.mockResolvedValueOnce(2);
    await expect(healthConnectAvailabilityNow()).resolves.toBe('needs-install');
    hc.getSdkStatus.mockRejectedValueOnce(new Error('x'));
    await expect(healthConnectAvailabilityNow()).resolves.toBe('unavailable');
  });

  it('opens the Play Store on Health Connect', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValueOnce(true);
    await openHealthConnectInstall();
    expect(open).toHaveBeenCalledWith(
      expect.stringContaining('market://details?id=com.google.android.apps.healthdata'),
    );
  });
});

describe('requestHealthConnectPermissions', () => {
  it('requests exercise, distance and history', async () => {
    hc.requestPermission.mockResolvedValueOnce([EX, DIST, HIST]);
    await expect(requestHealthConnectPermissions()).resolves.toBe('granted');
    expect(hc.requestPermission).toHaveBeenCalledWith([EX, DIST, HIST]);
  });

  it('is partial without history, denied without exercise', async () => {
    hc.requestPermission.mockResolvedValueOnce([EX, DIST]);
    await expect(requestHealthConnectPermissions()).resolves.toBe('partial');
    hc.requestPermission.mockResolvedValueOnce([DIST]);
    await expect(requestHealthConnectPermissions()).resolves.toBe('denied');
    hc.requestPermission.mockRejectedValueOnce(new Error('x'));
    await expect(requestHealthConnectPermissions()).resolves.toBe('denied');
  });

  it('is denied when Health Connect is missing or will not initialize', async () => {
    hc.getSdkStatus.mockResolvedValueOnce(2);
    await expect(requestHealthConnectPermissions()).resolves.toBe('denied');
    hc.initialize.mockRejectedValueOnce(new Error('x'));
    await expect(requestHealthConnectPermissions()).resolves.toBe('denied');
  });
});

describe('healthConnectSource.list', () => {
  it('pages through sessions, maps them and reads distances when allowed', async () => {
    hc.getGrantedPermissions.mockResolvedValueOnce([EX, DIST]);
    hc.readRecords
      .mockResolvedValueOnce({
        records: [session('A', 0, { title: ' Mont-Sainte-Anne ' })],
        pageToken: 'p2',
      } as never)
      .mockResolvedValueOnce({
        records: [
          session('B', 5_000_000, {
            exerciseType: 57,
            exerciseRoute: { type: 'NO_DATA', route: [] },
          }),
          session('OLD', -10_000_000),
          session('', 0),
        ],
        pageToken: '',
      } as never);
    hc.aggregateRecord
      .mockResolvedValueOnce({ DISTANCE: { inMeters: 8200 } } as never)
      .mockRejectedValueOnce(new Error('x'));

    const list = await healthConnectSource.list(T0 - 1, signal);

    expect(hc.readRecords).toHaveBeenNthCalledWith(1, 'ExerciseSession', {
      timeRangeFilter: { operator: 'after', startTime: iso(-1) },
      ascendingOrder: false,
      pageSize: 50,
      pageToken: undefined,
    });
    expect(hc.readRecords).toHaveBeenNthCalledWith(
      2,
      'ExerciseSession',
      expect.objectContaining({ pageToken: 'p2' }),
    );
    expect(hc.aggregateRecord).toHaveBeenCalledWith({
      recordType: 'Distance',
      timeRangeFilter: { operator: 'between', startTime: iso(0), endTime: iso(3_600_000) },
    });
    expect(list).toEqual([
      {
        origin: { source: 'health-connect', externalId: 'B' },
        name: undefined,
        category: 'run',
        sportLabel: 'Treadmill Run',
        startedAt: T0 + 5_000_000,
        distanceM: 0,
        hasRoute: false,
      },
      {
        origin: { source: 'health-connect', externalId: 'A' },
        name: 'Mont-Sainte-Anne',
        category: 'hike',
        sportLabel: 'Hike',
        startedAt: T0,
        distanceM: 8200,
        hasRoute: true,
      },
    ]);
  });

  it('skips distance reads without the permission', async () => {
    hc.readRecords.mockResolvedValueOnce({ records: [session('A', 0)] } as never);
    const [a] = await healthConnectSource.list(0, signal);
    expect(a?.distanceM).toBe(0);
    expect(hc.aggregateRecord).not.toHaveBeenCalled();
  });

  it('is empty when the client cannot initialize', async () => {
    hc.initialize.mockResolvedValueOnce(false);
    await expect(healthConnectSource.list(0, signal)).resolves.toEqual([]);
  });
});

describe('healthConnectSource.fetchRoute', () => {
  const activity = {
    origin: { source: 'health-connect' as const, externalId: 'A' },
    startedAt: T0,
    distanceM: 0,
    hasRoute: true,
  };

  it('returns an inline route', async () => {
    hc.readRecord.mockResolvedValueOnce(
      session('A', 0, { exerciseRoute: { type: 'DATA', route: [hcLoc(10), hcLoc(0)] } }) as never,
    );
    const route = await healthConnectSource.fetchRoute(activity, signal, jest.fn());
    expect(hc.readRecord).toHaveBeenCalledWith('ExerciseSession', 'A');
    expect(route.points).toEqual([
      { latitude: 46.8, longitude: -71.2, time: T0, altitude: 110, accuracy: 6 },
      { latitude: 46.8, longitude: -71.2, time: T0 + 10, altitude: 110, accuracy: 6 },
    ]);
    expect(hc.requestExerciseRoute).not.toHaveBeenCalled();
  });

  it('asks for per-session consent when required', async () => {
    hc.readRecord.mockResolvedValueOnce(session('A', 0) as never);
    hc.requestExerciseRoute.mockResolvedValueOnce([hcLoc(0)] as never);
    const route = await healthConnectSource.fetchRoute(activity, signal, jest.fn());
    expect(hc.requestExerciseRoute).toHaveBeenCalledWith('A');
    expect(route.points).toHaveLength(1);
  });

  it('is empty when consent is declined or there is no route', async () => {
    hc.readRecord.mockResolvedValueOnce(session('A', 0) as never);
    hc.requestExerciseRoute.mockRejectedValueOnce(new Error('denied'));
    await expect(healthConnectSource.fetchRoute(activity, signal, jest.fn())).resolves.toEqual({
      points: [],
      segmentStarts: [],
    });
    hc.readRecord.mockResolvedValueOnce(
      session('A', 0, { exerciseRoute: { type: 'NO_DATA', route: [] } }) as never,
    );
    const r = await healthConnectSource.fetchRoute(activity, signal, jest.fn());
    expect(r.points).toEqual([]);
  });

  it('is empty when the client cannot initialize', async () => {
    hc.initialize.mockResolvedValueOnce(false);
    const r = await healthConnectSource.fetchRoute(activity, signal, jest.fn());
    expect(r.points).toEqual([]);
    expect(hc.readRecord).not.toHaveBeenCalled();
  });
});
