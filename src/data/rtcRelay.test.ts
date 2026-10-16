import Constants from 'expo-constants';

import { appInternetDeps, RTC_HOST, rtcRelayHost } from './rtcRelay';

jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));

const extra = (Constants.expoConfig as { extra: Record<string, unknown> }).extra;

afterEach(() => {
  delete extra['rtcRelayHost'];
});

it('uses the company relay by default, a bare host on mvxtechnologies.com', () => {
  expect(RTC_HOST).toBe('rtc.mvxtechnologies.com');
  expect(RTC_HOST).not.toMatch(/[/:]/);
  expect(rtcRelayHost()).toBe(RTC_HOST);
});

it('takes a build-time host, and none for a nearby-only build', () => {
  extra['rtcRelayHost'] = 'localhost:8787';
  expect(rtcRelayHost()).toBe('localhost:8787');
  extra['rtcRelayHost'] = 'none';
  expect(rtcRelayHost()).toBeNull();
  expect(appInternetDeps()).toBeUndefined();
});

it('hands the host and the socket factory to the group host', () => {
  const ws = jest.fn();
  expect(appInternetDeps(ws)).toEqual({ host: RTC_HOST, ws });
});
