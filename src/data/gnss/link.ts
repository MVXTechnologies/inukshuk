/**
 * The receiver link the GNSS session drives: the native module
 * (`modules/inukshuk-gnss`, typed in `@lib/gnss/nativeGnss`) — scan, known
 * devices, connect / disconnect / write and its events — or, where a binary
 * has no module (Jest, web, a dev client without it), the JS simulated
 * receiver (`./simulatedLink`) in debug and `EXPO_PUBLIC_GNSS_FAKE=1` builds.
 *
 * Builds with the module and `GNSS_FAKE_DEVICE=1` (E2E) use the module's own
 * simulated receiver instead: same native threads and events as Bluetooth.
 */
import {
  getNativeGnss,
  type GnssAvailability,
  type GnssDevice,
  type GnssLinkState,
  type GnssLinkStateName,
  type NativeGnssModule,
  type Subscription,
} from '@lib/gnss/nativeGnss';

import { simulatedLink } from './simulatedLink';

/** What the session uses of the native module (the TCP half is `./ntripSocket`'s). */
export type GnssLink = Pick<
  NativeGnssModule,
  | 'getAvailability'
  | 'getPermissionsAsync'
  | 'requestPermissionsAsync'
  | 'startScan'
  | 'stopScan'
  | 'getKnownDevices'
  | 'connect'
  | 'disconnect'
  | 'write'
  | 'getState'
  | 'addListener'
>;

export type LinkDevice = GnssDevice;
export type LinkState = GnssLinkState;
export type LinkStateName = GnssLinkStateName;
export type LinkAvailability = GnssAvailability;
export type LinkSubscription = Subscription;

/**
 * The JS simulated receiver stands in where the module is missing: debug
 * builds, and builds made with `EXPO_PUBLIC_GNSS_FAKE=1` — never a store build.
 */
export function simulatedReceiverEnabled(): boolean {
  return __DEV__ || process.env.EXPO_PUBLIC_GNSS_FAKE === '1';
}

let cached: GnssLink | null | undefined;

/**
 * The receiver link of this build: the native module when the binary has it
 * (2.5.0+), else the simulated one when enabled, else null (no receiver
 * support: the extension is not offered).
 */
export function gnssLink(): GnssLink | null {
  if (cached !== undefined) return cached;
  cached = getNativeGnss() ?? (simulatedReceiverEnabled() ? simulatedLink() : null);
  return cached;
}

/** Whether this build can use a receiver at all (the extension is offered). */
export function gnssLinkAvailable(): boolean {
  return gnssLink() !== null;
}

/** Test-only: forget the resolved link. */
export function resetGnssLinkForTests(): void {
  cached = undefined;
}
