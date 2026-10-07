import * as Location from 'expo-location';
import { Linking, PermissionsAndroid, Platform } from 'react-native';
import {
  applyReadinessFix,
  isApproximateLocation,
  readReadinessSnapshot,
  requestNotificationsForRecording,
  resetRecordingReadinessForTests,
} from './recordingReadiness';

jest.mock('expo-location', () => ({
  getForegroundPermissionsAsync: jest.fn(),
  requestForegroundPermissionsAsync: jest.fn(),
  getBackgroundPermissionsAsync: jest.fn(),
  requestBackgroundPermissionsAsync: jest.fn(),
}));

const originalOS = Platform.OS;
const originalVersion = Platform.Version;
function setPlatform(os: string, version: number | string) {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
  Object.defineProperty(Platform, 'Version', { value: version, configurable: true });
}

const fg = (over: Record<string, unknown> = {}) =>
  ({ granted: true, status: 'granted', canAskAgain: true, expires: 'never', ...over }) as never;

let openSettings: jest.SpyInstance;
let sendIntent: jest.SpyInstance;
let check: jest.SpyInstance;
let request: jest.SpyInstance;

beforeEach(() => {
  resetRecordingReadinessForTests();
  jest.mocked(Location.getForegroundPermissionsAsync).mockReset();
  jest.mocked(Location.requestForegroundPermissionsAsync).mockReset();
  jest.mocked(Location.getBackgroundPermissionsAsync).mockReset();
  jest.mocked(Location.requestBackgroundPermissionsAsync).mockReset();
  openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
  sendIntent = jest.spyOn(Linking, 'sendIntent').mockResolvedValue(undefined);
  check = jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(true);
  request = jest.spyOn(PermissionsAndroid, 'request').mockResolvedValue('granted');
});

afterEach(() => {
  setPlatform(originalOS, originalVersion as number);
  jest.restoreAllMocks();
});

describe('readReadinessSnapshot', () => {
  it('iOS: reads precision from ios.accuracy and never queries background', async () => {
    setPlatform('ios', '18.0');
    jest
      .mocked(Location.getForegroundPermissionsAsync)
      .mockResolvedValue(fg({ ios: { scope: 'whenInUse', accuracy: 'reduced' } }));
    const snap = await readReadinessSnapshot(false);
    expect(snap).toMatchObject({
      platform: 'ios',
      osVersion: 18,
      location: 'granted',
      precise: false,
      notifications: null,
    });
    expect(Location.getBackgroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it('Android 14: coarse-only, background, notifications and the manufacturer', async () => {
    setPlatform('android', 34);
    Object.defineProperty(Platform, 'constants', {
      value: { Manufacturer: 'samsung', Brand: 'samsung' },
      configurable: true,
    });
    jest
      .mocked(Location.getForegroundPermissionsAsync)
      .mockResolvedValue(fg({ android: { accuracy: 'coarse' } }));
    jest
      .mocked(Location.getBackgroundPermissionsAsync)
      .mockResolvedValue(fg({ granted: false, status: 'denied', canAskAgain: false }));
    check.mockResolvedValue(false);
    const snap = await readReadinessSnapshot(true);
    expect(snap).toMatchObject({
      platform: 'android',
      precise: false,
      background: 'denied',
      backgroundCanAskAgain: false,
      notifications: 'denied',
      notificationsCanAskAgain: true,
      batteryReviewed: true,
    });
    expect(snap.manufacturer).toContain('samsung');
  });

  it('Android 12: no notifications row', async () => {
    setPlatform('android', 31);
    jest
      .mocked(Location.getForegroundPermissionsAsync)
      .mockResolvedValue(fg({ android: { accuracy: 'fine' } }));
    jest.mocked(Location.getBackgroundPermissionsAsync).mockResolvedValue(fg());
    const snap = await readReadinessSnapshot(false);
    expect(snap.notifications).toBeNull();
    expect(snap.precise).toBe(true);
    expect(snap.background).toBe('granted');
  });

  it('a throwing permission API reads as not granted, never throws', async () => {
    setPlatform('android', 34);
    jest.mocked(Location.getForegroundPermissionsAsync).mockRejectedValue(new Error('boom'));
    jest.mocked(Location.getBackgroundPermissionsAsync).mockRejectedValue(new Error('boom'));
    check.mockRejectedValue(new Error('boom'));
    const snap = await readReadinessSnapshot(false);
    expect(snap).toMatchObject({ location: 'denied', precise: null, notifications: 'denied' });
  });

  it('undetermined stays undetermined', async () => {
    setPlatform('ios', '17');
    jest
      .mocked(Location.getForegroundPermissionsAsync)
      .mockResolvedValue(fg({ granted: false, status: 'undetermined' }));
    expect((await readReadinessSnapshot(false)).location).toBe('undetermined');
  });
});

describe('isApproximateLocation', () => {
  it.each([
    ['ios', { ios: { accuracy: 'reduced' } }, true],
    ['ios', { ios: { accuracy: 'full' } }, false],
    ['android', { android: { accuracy: 'coarse' } }, true],
    ['android', { android: { accuracy: 'fine' } }, false],
    ['ios', {}, null],
  ])('%s %j → %s', async (os, details, expected) => {
    setPlatform(os, 34);
    jest.mocked(Location.getForegroundPermissionsAsync).mockResolvedValue(fg(details));
    await expect(isApproximateLocation()).resolves.toBe(expected);
  });

  it('is unknown without permission', async () => {
    jest
      .mocked(Location.getForegroundPermissionsAsync)
      .mockResolvedValue(fg({ granted: false, status: 'denied' }));
    await expect(isApproximateLocation()).resolves.toBeNull();
  });
});

describe('applyReadinessFix', () => {
  it('Android precise: re-requests, and opens settings only when the dialog is blocked', async () => {
    setPlatform('android', 34);
    jest
      .mocked(Location.requestForegroundPermissionsAsync)
      .mockResolvedValue(fg({ android: { accuracy: 'fine' } }));
    await applyReadinessFix('request-precise');
    expect(openSettings).not.toHaveBeenCalled();

    jest
      .mocked(Location.requestForegroundPermissionsAsync)
      .mockResolvedValue(fg({ android: { accuracy: 'coarse' }, canAskAgain: false }));
    await applyReadinessFix('request-precise');
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it('background: asks, falls back to settings when blocked', async () => {
    setPlatform('android', 34);
    jest
      .mocked(Location.requestBackgroundPermissionsAsync)
      .mockResolvedValue(fg({ granted: false, status: 'denied', canAskAgain: false }));
    await applyReadinessFix('request-background');
    expect(Location.requestBackgroundPermissionsAsync).toHaveBeenCalled();
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it('notifications: a "never ask again" answer opens settings and is remembered', async () => {
    setPlatform('android', 34);
    request.mockResolvedValue(PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN);
    jest
      .mocked(Location.getForegroundPermissionsAsync)
      .mockResolvedValue(fg({ android: { accuracy: 'fine' } }));
    jest.mocked(Location.getBackgroundPermissionsAsync).mockResolvedValue(fg());
    await applyReadinessFix('request-notifications');
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect((await readReadinessSnapshot(false)).notificationsCanAskAgain).toBe(false);
    // …and the record-start prompt no longer fires at all.
    request.mockClear();
    await requestNotificationsForRecording();
    expect(request).not.toHaveBeenCalled();
  });

  it('battery: Android 12+ opens the app page (Battery › Unrestricted)', async () => {
    setPlatform('android', 34);
    await applyReadinessFix('open-battery-settings');
    expect(sendIntent).not.toHaveBeenCalled();
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it('battery: Android 11 opens the optimization list without any special permission', async () => {
    setPlatform('android', 30);
    await applyReadinessFix('open-battery-settings');
    expect(sendIntent).toHaveBeenCalledWith(
      'android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS',
    );
    expect(openSettings).not.toHaveBeenCalled();
  });

  it('battery: falls back to the app page when the intent is unavailable', async () => {
    setPlatform('android', 29);
    sendIntent.mockRejectedValue(new Error('no activity'));
    await applyReadinessFix('open-battery-settings');
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it('iOS precise: the app Settings page', async () => {
    setPlatform('ios', '18');
    await applyReadinessFix('open-app-settings');
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it('a throwing request falls back to settings', async () => {
    jest.mocked(Location.requestForegroundPermissionsAsync).mockRejectedValue(new Error('x'));
    await applyReadinessFix('request-location');
    expect(openSettings).toHaveBeenCalledTimes(1);
  });
});

describe('requestNotificationsForRecording', () => {
  it('asks on Android 13+ only', async () => {
    setPlatform('android', 32);
    await requestNotificationsForRecording();
    expect(request).not.toHaveBeenCalled();
    setPlatform('android', 33);
    await requestNotificationsForRecording();
    expect(request).toHaveBeenCalledTimes(1);
    setPlatform('ios', '18');
    await requestNotificationsForRecording();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('never throws', async () => {
    setPlatform('android', 34);
    request.mockRejectedValue(new Error('x'));
    await expect(requestNotificationsForRecording()).resolves.toBeUndefined();
  });
});
