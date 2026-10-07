/**
 * The simulated receiver, in JS: a `GnssLink` that replays the core's
 * scripted Québec City RTK session (`@core/gnss/sim`: Plains of Abraham, 1 Hz,
 * autonomous → RTK float → RTK fixed → corrections lost → float → autonomous,
 * looping) through the native module's events.
 *
 * For binaries without the native module (Jest, web, a dev client without
 * it). Builds with the module use its own simulated receiver (`fake`
 * transport), fed the same frames (`simulatedFrames`) by the session.
 */
import { bytesToBase64 } from '@core/encoding/base64';
import { asciiToBytes } from '@core/gnss/bytes';
import { nmeaEpoch, quebecRtkSession } from '@core/gnss/sim';
import type { GnssEvents, GnssLinkState, NativeGnssModule } from '@lib/gnss/nativeGnss';
import type { PermissionResponse, PermissionStatus } from 'expo';

import type { GnssLink, LinkAvailability, LinkDevice, LinkSubscription } from './link';

export const SIMULATED_RECEIVER_ID = 'inukshuk-simulated-receiver';
export const SIMULATED_RECEIVER_NAME = 'Simulated RTK receiver';

/** One epoch a second, like the scripted session. */
export const SIMULATED_INTERVAL_MS = 1000;
const CONNECT_MS = 400;
const SCAN_FOUND_MS = 300;

export const SIMULATED_DEVICE: LinkDevice = {
  id: SIMULATED_RECEIVER_ID,
  name: SIMULATED_RECEIVER_NAME,
  transport: 'fake',
  rssi: -48,
  serviceUuids: [],
  bonded: false,
};

let frames: string[] | null = null;

/** The session's epochs as base64 chunks (one per epoch), encoded once. */
export function simulatedFrames(): string[] {
  frames ??= quebecRtkSession().epochs.map((e) => bytesToBase64(asciiToBytes(nmeaEpoch(e))));
  return frames;
}

type Listeners = { [K in keyof GnssEvents]: Set<GnssEvents[K]> };

const IDLE: GnssLinkState = {
  state: 'idle',
  deviceId: null,
  transport: null,
  mtu: null,
  profile: null,
  writable: false,
  attempt: 0,
  reason: null,
  retryInMs: null,
};

const GRANTED: PermissionResponse = {
  // PermissionStatus.GRANTED (a type import: the enum is a runtime value of `expo`).
  status: 'granted' as PermissionStatus,
  granted: true,
  canAskAgain: true,
  expires: 'never',
};

export class SimulatedLink implements GnssLink {
  private listeners: Listeners = {
    onBytes: new Set(),
    onState: new Set(),
    onDevice: new Set(),
    onScanState: new Set(),
    onRssi: new Set(),
    onError: new Set(),
    onAvailability: new Set(),
    onTcpData: new Set(),
    onTcpClose: new Set(),
  };
  private state: GnssLinkState = IDLE;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private pump: ReturnType<typeof setInterval> | null = null;
  private index = 0;
  /** Bytes written to the receiver (RTCM corrections, UBX config). */
  written = 0;
  /** Every write, in order (tests). */
  writes: Uint8Array[] = [];

  async getAvailability(): Promise<LinkAvailability> {
    return {
      supported: true,
      ble: false,
      classic: false,
      poweredOn: true,
      transports: ['fake'],
      fakeDevice: true,
    };
  }

  async getPermissionsAsync(): Promise<PermissionResponse> {
    return GRANTED;
  }

  async requestPermissionsAsync(): Promise<PermissionResponse> {
    return GRANTED;
  }

  async startScan(options: { durationMs: number }): Promise<void> {
    this.emit('onScanState', { scanning: true, reason: null });
    this.later(SCAN_FOUND_MS, () => this.emit('onDevice', SIMULATED_DEVICE));
    this.later(Math.min(options.durationMs, 2000), () =>
      this.emit('onScanState', { scanning: false, reason: 'timeout' }),
    );
  }

  async stopScan(): Promise<void> {
    this.emit('onScanState', { scanning: false, reason: 'user' });
  }

  async getKnownDevices(): Promise<LinkDevice[]> {
    return [];
  }

  /** Every connect call (tests). */
  connects: Parameters<NativeGnssModule['connect']>[0][] = [];

  /** `anyDevice`: answer for every device id (tests that need a "real" receiver). */
  constructor(private readonly anyDevice = false) {}

  async connect(options: Parameters<NativeGnssModule['connect']>[0]): Promise<void> {
    this.connects.push(options);
    if (!this.anyDevice && options.deviceId !== SIMULATED_RECEIVER_ID) {
      this.emit('onError', {
        code: 'E_GNSS_UNKNOWN_DEVICE',
        message: 'This build only has the simulated receiver',
        deviceId: options.deviceId,
        fatal: true,
      });
      return;
    }
    this.stopPump();
    this.setState({
      ...IDLE,
      state: 'connecting',
      deviceId: options.deviceId,
      transport: options.transport,
    });
    this.later(CONNECT_MS, () => {
      this.setState({ ...this.state, state: 'connected', writable: true, profile: 'fake' });
      this.index = 0;
      this.pump = setInterval(() => this.sendEpoch(), SIMULATED_INTERVAL_MS);
      this.sendEpoch();
    });
  }

  async disconnect(): Promise<void> {
    this.stopPump();
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (this.state.state !== 'idle') {
      this.setState({ ...this.state, state: 'disconnected', writable: false, reason: 'user' });
    }
  }

  async write(data: Uint8Array): Promise<void> {
    if (this.state.state !== 'connected') throw new Error('E_GNSS_NOT_CONNECTED');
    this.written += data.length;
    this.writes.push(data);
  }

  getState(): GnssLinkState {
    return this.state;
  }

  addListener<K extends keyof GnssEvents>(event: K, listener: GnssEvents[K]): LinkSubscription {
    const set = this.listeners[event] as Set<GnssEvents[K]>;
    set.add(listener);
    return { remove: () => set.delete(listener) };
  }

  private sendEpoch(): void {
    const all = simulatedFrames();
    const data = all[this.index % all.length] ?? '';
    this.index += 1;
    this.emit('onBytes', {
      deviceId: this.state.deviceId ?? SIMULATED_RECEIVER_ID,
      data,
      length: Math.floor((data.length * 3) / 4),
      dropped: 0,
    });
  }

  private stopPump(): void {
    if (this.pump !== null) clearInterval(this.pump);
    this.pump = null;
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers = this.timers.filter((x) => x !== t);
      fn();
    }, ms);
    this.timers.push(t);
  }

  private setState(s: GnssLinkState): void {
    this.state = s;
    this.emit('onState', s);
  }

  private emit<K extends keyof GnssEvents>(event: K, payload: Parameters<GnssEvents[K]>[0]): void {
    for (const l of [...this.listeners[event]]) (l as (p: typeof payload) => void)(payload);
  }
}

let instance: SimulatedLink | null = null;

/** The one simulated link of this JS process. */
export function simulatedLink(): SimulatedLink {
  instance ??= new SimulatedLink();
  return instance;
}
