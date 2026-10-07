import { DEFAULT_GNSS_PROFILES, type GattProfile } from '@core/gnss/bleProfiles';
import type { PermissionResponse } from 'expo';
import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

/**
 * Typed access to the `InukshukGnss` native module (modules/inukshuk-gnss):
 * a byte pipe to an external GNSS receiver over Bluetooth, nothing more.
 * Parsing (NMEA / UBX / RTCM), fix assembly and NTRIP live in @core/gnss;
 * src/data/gnss/receiverStream.ts joins the two.
 *
 * Optional on purpose: binaries built before 2.5.0 have no such module, and
 * JS shipped to them over the air must degrade (`getNativeGnss()` → null),
 * the same pattern as src/lib/iap.ts.
 */

/** `ble` both platforms; `spp` (Bluetooth Classic) Android only; `fake` test builds only. */
export type GnssTransport = 'ble' | 'spp' | 'fake';

export type GnssLinkStateName =
  'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

/** Error codes the native side reports (onError, promise rejections). */
export type GnssErrorCode =
  | 'E_GNSS_UNAVAILABLE'
  | 'E_GNSS_BLUETOOTH_OFF'
  | 'E_GNSS_PERMISSION'
  | 'E_GNSS_BAD_ARGUMENT'
  | 'E_GNSS_UNSUPPORTED_TRANSPORT'
  | 'E_GNSS_UNKNOWN_DEVICE'
  | 'E_GNSS_NOT_BONDED'
  | 'E_GNSS_CONNECT_FAILED'
  | 'E_GNSS_CONNECT_TIMEOUT'
  | 'E_GNSS_NO_SERIAL_SERVICE'
  | 'E_GNSS_NOTIFY_FAILED'
  | 'E_GNSS_LINK_LOST'
  | 'E_GNSS_NOT_CONNECTED'
  | 'E_GNSS_NOT_WRITABLE'
  | 'E_GNSS_WRITE_OVERFLOW'
  | 'E_GNSS_WRITE_FAILED'
  | 'E_GNSS_WRITE_STALLED'
  | 'E_GNSS_SCAN_FAILED'
  | 'E_GNSS_FAKE_DISABLED'
  | 'E_GNSS_FAKE_ENDED';

export interface GnssAvailability {
  /** The device can run at least one Bluetooth transport. */
  supported: boolean;
  ble: boolean;
  /** Bluetooth Classic SPP (Android only). */
  classic: boolean;
  /** null on iOS until Bluetooth has been used once (asking could prompt). */
  poweredOn: boolean | null;
  transports: GnssTransport[];
  /** The simulated receiver is available (debug builds, or GNSS_FAKE_DEVICE=1). */
  fakeDevice: boolean;
}

export interface GnssDevice {
  /** Android: MAC address. iOS: CoreBluetooth peripheral UUID (per phone). */
  id: string;
  name: string | null;
  transport: GnssTransport;
  rssi: number | null;
  /** Advertised (BLE) or SDP-cached (bonded Classic) service UUIDs, normalised. */
  serviceUuids: string[];
  bonded: boolean;
  connectable?: boolean | null;
  /** Bonded Android devices: what Android knows the device to be. */
  deviceType?: 'classic' | 'le' | 'dual' | 'unknown';
  /** Bonded Android devices: SPP seen in the cached SDP record (null: unknown). */
  supportsSpp?: boolean | null;
}

export interface GnssLinkState {
  state: GnssLinkStateName;
  deviceId: string | null;
  transport: GnssTransport | null;
  /** Negotiated ATT MTU (BLE), null otherwise. */
  mtu: number | null;
  /** The GATT profile in use (`nordic-uart`…), `spp` or `fake`. */
  profile: string | null;
  /** Writes (UBX config, RTCM corrections) are possible. */
  writable: boolean;
  /** Reconnect attempts since the last stable link. */
  attempt: number;
  /** Why the link left `connected` (an error code, `user`, `bluetooth-off`). */
  reason: string | null;
  /** Delay before the next attempt; null when the OS waits for the device (iOS). */
  retryInMs: number | null;
}

export interface GnssBytesEvent {
  deviceId: string | null;
  /** Base64 of the received bytes (≤ 64 KiB, ≤ 10 events per second). */
  data: string;
  length: number;
  /** Bytes lost before this chunk (native buffer overflow): resync the framer. */
  dropped: number;
}

export interface GnssErrorEvent {
  code: GnssErrorCode | string;
  message: string;
  deviceId: string | null;
  /** True when the link gave up (no automatic retry follows). */
  fatal: boolean;
}

export interface GnssScanStateEvent {
  scanning: boolean;
  reason: string | null;
}

export interface GnssRssiEvent {
  deviceId: string | null;
  rssi: number;
}

export interface GnssConnectOptions {
  deviceId: string;
  transport: GnssTransport;
  /** BLE only: candidate serial profiles, in priority order. */
  profiles?: GattProfile[];
  /** Retry with backoff (and iOS pending connects) after a drop. Default true. */
  autoReconnect?: boolean;
  /** Android BLE: ATT MTU to request (23–517). iOS negotiates by itself. */
  mtu?: number;
  /** The simulated receiver's frames (base64) and pacing. */
  fake?: { frames: string[]; intervalMs: number; loop: boolean };
}

export interface GnssEvents {
  onBytes: (e: GnssBytesEvent) => void;
  onState: (e: GnssLinkState) => void;
  onDevice: (e: GnssDevice) => void;
  onScanState: (e: GnssScanStateEvent) => void;
  onRssi: (e: GnssRssiEvent) => void;
  onError: (e: GnssErrorEvent) => void;
  onAvailability: (e: GnssAvailability) => void;
}

export interface Subscription {
  remove(): void;
}

/** The native module's surface (both platforms implement all of it). */
export interface NativeGnssModule {
  getAvailability(): Promise<GnssAvailability>;
  getPermissionsAsync(): Promise<PermissionResponse>;
  /** Android 12+: Nearby devices. Android 8–11: precise location (BLE scan). iOS: Bluetooth. */
  requestPermissionsAsync(): Promise<PermissionResponse>;
  startScan(options: { durationMs: number }): Promise<void>;
  stopScan(): Promise<void>;
  /** Android: bonded devices. iOS: peripherals already connected with these services. */
  getKnownDevices(options: { serviceUuids: string[] }): Promise<GnssDevice[]>;
  /** Resolves once the attempt is under way; follow `onState`. */
  connect(
    options: Required<Omit<GnssConnectOptions, 'fake'>> & Pick<GnssConnectOptions, 'fake'>,
  ): Promise<void>;
  disconnect(): Promise<void>;
  /** Resolves when the bytes left the phone (BLE: split to the MTU natively). */
  write(data: Uint8Array): Promise<void>;
  getState(): GnssLinkState;
  addListener<K extends keyof GnssEvents>(event: K, listener: GnssEvents[K]): Subscription;
}

export const DEFAULT_SCAN_MS = 15_000;
/** Android caps an MTU request at 517 (iOS ignores it). */
export const DEFAULT_BLE_MTU = 517;

export function getNativeGnss(): NativeGnssModule | null {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') return null;
  return requireOptionalNativeModule<NativeGnssModule>('InukshukGnss');
}

/** False on binaries without the module (pre-2.5.0) and on web. */
export function gnssNativeAvailable(): boolean {
  return getNativeGnss() !== null;
}

/** Fills the defaults the native side expects. */
export function connectOptions(o: GnssConnectOptions): Parameters<NativeGnssModule['connect']>[0] {
  return {
    deviceId: o.deviceId,
    transport: o.transport,
    profiles: o.transport === 'ble' ? (o.profiles ?? [...DEFAULT_GNSS_PROFILES]) : [],
    autoReconnect: o.autoReconnect ?? true,
    mtu: o.mtu ?? DEFAULT_BLE_MTU,
    ...(o.fake ? { fake: o.fake } : {}),
  };
}
