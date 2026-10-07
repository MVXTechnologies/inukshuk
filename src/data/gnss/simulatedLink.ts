/**
 * The simulated receiver, in JS: a `GnssLink` that replays the core's
 * scripted Québec City RTK session (`@core/gnss/sim`: Plains of Abraham, 1 Hz,
 * autonomous → RTK float → RTK fixed → corrections lost → float → autonomous,
 * looping) through the same events a Bluetooth receiver produces.
 *
 * It lets the whole receiver UI run without hardware — Jest, the Maestro
 * flow, screenshots — and before the native module lands. Offered only in
 * debug builds and `EXPO_PUBLIC_GNSS_FAKE=1` builds (`./link`).
 */
import { bytesToBase64 } from '@core/encoding/base64';
import { asciiToBytes } from '@core/gnss/bytes';
import { nmeaEpoch, quebecRtkSession } from '@core/gnss/sim';

import type {
  GnssLink,
  LinkAvailability,
  LinkDevice,
  LinkEvents,
  LinkState,
  LinkSubscription,
} from './link';

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

type Listeners = { [K in keyof LinkEvents]: Set<LinkEvents[K]> };

const IDLE: LinkState = {
  state: 'idle',
  deviceId: null,
  transport: null,
  writable: false,
  attempt: 0,
  reason: null,
  retryInMs: null,
};

export class SimulatedLink implements GnssLink {
  private listeners: Listeners = {
    onBytes: new Set(),
    onState: new Set(),
    onDevice: new Set(),
    onScanState: new Set(),
    onError: new Set(),
  };
  private state: LinkState = IDLE;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private pump: ReturnType<typeof setInterval> | null = null;
  private index = 0;
  /** Bytes written to the receiver (RTCM corrections, UBX config). */
  written = 0;

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

  async getPermissionsAsync() {
    return { granted: true, canAskAgain: true };
  }

  async requestPermissionsAsync() {
    return { granted: true, canAskAgain: true };
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

  async connect(options: { deviceId: string }): Promise<void> {
    if (options.deviceId !== SIMULATED_RECEIVER_ID) {
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
      deviceId: SIMULATED_RECEIVER_ID,
      transport: 'fake',
    });
    this.later(CONNECT_MS, () => {
      this.setState({ ...this.state, state: 'connected', writable: true });
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
  }

  getState(): LinkState {
    return this.state;
  }

  addListener<K extends keyof LinkEvents>(event: K, listener: LinkEvents[K]): LinkSubscription {
    const set = this.listeners[event] as Set<LinkEvents[K]>;
    set.add(listener);
    return { remove: () => set.delete(listener) };
  }

  private sendEpoch(): void {
    const all = simulatedFrames();
    const data = all[this.index % all.length] ?? '';
    this.index += 1;
    this.emit('onBytes', {
      deviceId: SIMULATED_RECEIVER_ID,
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

  private setState(s: LinkState): void {
    this.state = s;
    this.emit('onState', s);
  }

  private emit<K extends keyof LinkEvents>(event: K, payload: Parameters<LinkEvents[K]>[0]): void {
    for (const l of [...this.listeners[event]]) (l as (p: typeof payload) => void)(payload);
  }
}

let instance: SimulatedLink | null = null;

/** The one simulated link of this JS process. */
export function simulatedLink(): SimulatedLink {
  instance ??= new SimulatedLink();
  return instance;
}
