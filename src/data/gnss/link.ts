/**
 * The receiver link the GNSS session drives: the part of the native module's
 * JS API (`modules/inukshuk-gnss`, `@lib/gnss/nativeGnss` on feat/gnss-native)
 * the UI needs — scan, known devices, connect / disconnect / write, and the
 * byte, state, device and error events.
 *
 * Structural on purpose, like that branch's `receiverStream.ts` is against
 * the core: the native module satisfies it as is, so this builds and is
 * tested before the module lands, and the module plugs in without a change
 * here. Until then (and in tests, Maestro and screenshots) the simulated
 * receiver (`./simulatedLink`) stands in, in debug and E2E builds only.
 */
import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

import { simulatedLink } from './simulatedLink';

export type LinkTransport = 'ble' | 'spp' | 'fake';

export type LinkStateName = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface LinkAvailability {
  supported: boolean;
  ble: boolean;
  classic: boolean;
  poweredOn: boolean | null;
  transports: LinkTransport[];
  fakeDevice: boolean;
}

export interface LinkDevice {
  id: string;
  name: string | null;
  transport: LinkTransport;
  rssi: number | null;
  serviceUuids: string[];
  bonded: boolean;
}

export interface LinkState {
  state: LinkStateName;
  deviceId: string | null;
  transport: LinkTransport | null;
  writable: boolean;
  attempt: number;
  reason: string | null;
  retryInMs: number | null;
}

export interface LinkBytesEvent {
  deviceId: string | null;
  /** Base64 of the received bytes. */
  data: string;
  length: number;
  /** Bytes the native buffer dropped before this chunk: the stream is not continuous. */
  dropped: number;
}

export interface LinkErrorEvent {
  code: string;
  message: string;
  deviceId: string | null;
  fatal: boolean;
}

export interface LinkEvents {
  onBytes: (e: LinkBytesEvent) => void;
  onState: (e: LinkState) => void;
  onDevice: (e: LinkDevice) => void;
  onScanState: (e: { scanning: boolean; reason: string | null }) => void;
  onError: (e: LinkErrorEvent) => void;
}

export interface LinkSubscription {
  remove(): void;
}

export interface LinkPermission {
  granted: boolean;
  canAskAgain: boolean;
}

export interface LinkConnectOptions {
  deviceId: string;
  transport: LinkTransport;
  autoReconnect: boolean;
  /** The native module's simulated receiver (`fake` transport): what it replays. */
  fake?: { frames: string[]; intervalMs: number; loop: boolean };
}

/** What the session needs from the receiver link (the native module's shape). */
export interface GnssLink {
  getAvailability(): Promise<LinkAvailability>;
  getPermissionsAsync(): Promise<LinkPermission>;
  requestPermissionsAsync(): Promise<LinkPermission>;
  startScan(options: { durationMs: number }): Promise<void>;
  stopScan(): Promise<void>;
  getKnownDevices(options: { serviceUuids: string[] }): Promise<LinkDevice[]>;
  connect(options: LinkConnectOptions): Promise<void>;
  disconnect(): Promise<void>;
  write(data: Uint8Array): Promise<void>;
  getState(): LinkState;
  addListener<K extends keyof LinkEvents>(event: K, listener: LinkEvents[K]): LinkSubscription;
}

/**
 * The simulated receiver is offered in debug builds and in builds made with
 * `EXPO_PUBLIC_GNSS_FAKE=1` (E2E, screenshots) — never in a store build.
 * The native module's own `fake` transport (GNSS_FAKE_DEVICE=1) is the same
 * idea one layer down; either one enables the Maestro flow.
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
  const native =
    Platform.OS === 'android' || Platform.OS === 'ios'
      ? requireOptionalNativeModule<GnssLink>('InukshukGnss')
      : null;
  cached = native ?? (simulatedReceiverEnabled() ? simulatedLink() : null);
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
