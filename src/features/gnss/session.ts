/**
 * The receiver session: the one place the external GNSS receiver (#588) is
 * driven from. It joins the link (`@data/gnss/link`: the native module, or
 * the simulated receiver) to the pure core (`@core/gnss/receiver`: bytes →
 * fixes → quality → position source) and publishes the result to
 * `useGnssStore`, which the chip, the sheet, the location hook and the
 * recorder read.
 *
 * - every received chunk goes, in order, into one pipeline per connection;
 *   a link drop or a native overflow is a discontinuity (flush + reset);
 * - a 1 s tick notices silence (stale → lost) and drives the source policy;
 * - while the receiver is the source, its fixes (moved to WGS 84 for the map)
 *   are the recorder's points; the phone's are not (`phoneFeedsRecorder`);
 * - corrections: the active NTRIP profile streams to the receiver.
 */
import { liteEngine } from '@core/convert/lite';
import type { Engine } from '@core/convert/run';
import { activeProfile, correctionsOf, type PairedReceiver } from '@core/gnss/config';
import type { GnssFix } from '@core/gnss/fix';
import { drawnPosition, FixOutputs } from '@core/gnss/output';
import { projectDatumOption } from '@core/gnss/projectDatum';
import {
  arbitrate,
  INITIAL_SOURCE,
  ReceiverPipeline,
  shouldRecord,
  trackPointFromFix,
  type MapPosition,
  type SourceState,
} from '@core/gnss/receiver';
import { gnssSecrets } from '@data/gnss/credentials';
import { gnssLink, type GnssLink, type LinkDevice, type LinkSubscription } from '@data/gnss/link';
import { ntripSocketFactory } from '@data/gnss/ntripSocket';
import { initNativeProj, nativeEngine } from '@lib/nativeProj';
import { reportError } from '@lib/errorReporting';
import { useGnssStore } from '@state/gnssStore';
import { useRecorderStore } from '@state/recorderStore';
import { useSettingsStore } from '@state/settingsStore';

import { NtripClient } from './ntripClient';

/** Silence check and source policy cadence. */
export const TICK_MS = 1000;
/** Publish fixes to the UI at most this often (a 10 Hz receiver needn't redraw 10×). */
export const PUBLISH_MS = 250;
/** How long a scan runs. */
export const SCAN_MS = 15_000;

function base64Bytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function engine(): Engine {
  const e = nativeEngine();
  if (e) initNativeProj([]);
  return e ?? liteEngine;
}

/** A receiver error, in words. */
export function linkErrorMessage(code: string, fallback: string): string {
  switch (code) {
    case 'E_GNSS_BLUETOOTH_OFF':
      return 'Bluetooth is off — turn it on to use the receiver';
    case 'E_GNSS_PERMISSION':
      return 'Inukshuk needs the Bluetooth (Nearby devices) permission to reach the receiver';
    case 'E_GNSS_NOT_BONDED':
      return 'Pair the receiver in the phone’s Bluetooth settings first';
    case 'E_GNSS_CONNECT_TIMEOUT':
    case 'E_GNSS_CONNECT_FAILED':
      return 'Couldn’t connect — is the receiver on and close by?';
    case 'E_GNSS_NO_SERIAL_SERVICE':
      return 'This device doesn’t offer a GNSS data stream';
    default:
      return fallback;
  }
}

export class GnssSession {
  /** Scan, device and error listeners: the session object's whole life. */
  private subs: LinkSubscription[] = [];
  /** State and byte listeners: one connection. */
  private connSubs: LinkSubscription[] = [];
  private pipeline = new ReceiverPipeline();
  private outputs: FixOutputs | null = null;
  private ntrip: NtripClient;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private source: SourceState = INITIAL_SOURCE;
  private lastFed: MapPosition | null = null;
  private lastPublishMs = 0;
  private receiver: PairedReceiver | null = null;
  private connected = false;
  private ntripKey = '';

  constructor(
    private readonly link: GnssLink,
    private readonly now: () => number = Date.now,
  ) {
    this.ntrip = new NtripClient({
      sockets: ntripSocketFactory(),
      toReceiver: (bytes) => this.link.write(bytes),
      publish: (ntrip) => useGnssStore.getState().publish({ ntrip }),
      now: this.now,
    });
    this.subs.push(
      link.addListener('onDevice', (d) => this.onDevice(d)),
      link.addListener('onScanState', (e) =>
        useGnssStore.getState().publish({ scanning: e.scanning }),
      ),
      link.addListener('onError', (e) => {
        if (e.fatal || e.code === 'E_GNSS_BLUETOOTH_OFF' || e.code === 'E_GNSS_PERMISSION') {
          useGnssStore.getState().publish({ error: linkErrorMessage(e.code, e.message) });
        }
      }),
    );
  }

  // ---- scanning (Settings → Connect a receiver) -------------------------------------------

  async scan(): Promise<void> {
    const store = useGnssStore.getState();
    store.publish({ devices: [], error: null });
    try {
      let perm = await this.link.getPermissionsAsync();
      if (!perm.granted) perm = await this.link.requestPermissionsAsync();
      if (!perm.granted) {
        store.publish({ error: linkErrorMessage('E_GNSS_PERMISSION', '') });
        return;
      }
      const known = await this.link.getKnownDevices({ serviceUuids: [] });
      for (const d of known) this.onDevice(d);
      await this.link.startScan({ durationMs: SCAN_MS });
    } catch (e) {
      store.publish({
        scanning: false,
        error: linkErrorMessage(codeOf(e), 'Couldn’t look for receivers'),
      });
    }
  }

  stopScan(): void {
    void this.link.stopScan().catch(() => undefined);
  }

  private onDevice(d: LinkDevice): void {
    const { devices, publish } = useGnssStore.getState();
    const next = [...devices.filter((x) => x.id !== d.id), d].sort(
      (a, b) => (b.rssi ?? -999) - (a.rssi ?? -999),
    );
    publish({ devices: next });
  }

  // ---- the receiver -----------------------------------------------------------------------

  /** Connect to `receiver` and start using it. Idempotent for the same receiver. */
  start(receiver: PairedReceiver): void {
    if (this.receiver?.id === receiver.id && this.tickTimer !== null) return;
    this.stop();
    this.receiver = receiver;
    this.pipeline = new ReceiverPipeline();
    this.outputs = new FixOutputs(engine());
    this.source = INITIAL_SOURCE;
    this.lastFed = null;
    this.connSubs.push(
      this.link.addListener('onState', (s) => this.onState(s.state, s.reason)),
      this.link.addListener('onBytes', (e) => this.onBytes(e.data, e.dropped)),
    );
    useGnssStore.getState().publish({ link: 'connecting', error: null });
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.link
      .connect({ deviceId: receiver.id, transport: receiver.transport, autoReconnect: true })
      .catch((e: unknown) => {
        useGnssStore.getState().publish({
          link: 'disconnected',
          error: linkErrorMessage(codeOf(e), 'Couldn’t connect to the receiver'),
        });
      });
  }

  /** Disconnect and hand the location back to the phone. */
  stop(): void {
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    this.tickTimer = null;
    for (const s of this.connSubs) s.remove();
    this.connSubs = [];
    this.ntrip.stop();
    this.ntripKey = '';
    if (this.receiver !== null) void this.link.disconnect().catch(() => undefined);
    this.receiver = null;
    this.connected = false;
    const store = useGnssStore.getState();
    const { devices, scanning, error } = store;
    store.resetLive();
    store.publish({ devices, scanning, error });
  }

  /** Stream the active profile's corrections (or stop them); re-called when Settings change it. */
  async refreshCorrections(): Promise<void> {
    const profile = activeProfile(useGnssStore.getState().config);
    const key = profile === null ? '' : JSON.stringify(profile);
    if (!this.connected || key === this.ntripKey) return;
    this.ntripKey = key;
    if (profile === null) {
      this.ntrip.stop();
      return;
    }
    const password = (await gnssSecrets.get(profile.id)) ?? '';
    if (this.ntripKey !== key || !this.connected) return;
    this.ntrip.start(profile, password, this.pipeline.fix);
  }

  private onState(state: string, reason: string | null): void {
    const nowMs = this.now();
    const connected = state === 'connected';
    if (this.connected && !connected) {
      for (const f of this.pipeline.discontinuity(nowMs)) this.onFix(f, nowMs);
      this.ntrip.stop();
      this.ntripKey = '';
    }
    this.connected = connected;
    const link =
      state === 'connected' || state === 'connecting' || state === 'reconnecting'
        ? state
        : 'disconnected';
    useGnssStore.getState().publish({ link, linkReason: reason });
    if (connected) void this.refreshCorrections().catch((e) => reportError(e, 'gnss-ntrip'));
    this.tick();
  }

  private onBytes(data: string, dropped: number): void {
    const nowMs = this.now();
    if (dropped > 0) this.pipeline.discontinuity(nowMs);
    const bytes = base64Bytes(data);
    if (bytes === null) {
      this.pipeline.discontinuity(nowMs);
      return;
    }
    const fixes = this.pipeline.push(bytes, nowMs);
    for (const f of fixes) this.onFix(f, nowMs);
  }

  private onFix(fix: GnssFix, nowMs: number): void {
    const outputs = this.outputs;
    if (outputs === null) return;
    const { config } = useGnssStore.getState();
    const corrections = correctionsOf(config);
    const onMap = outputs.onMap(fix, corrections, nowMs);
    const pos = drawnPosition(fix, onMap);
    const outcome = this.decide(nowMs);
    const status = this.pipeline.status;
    if (outcome.use === 'external' && status.state !== 'no-fix') {
      const recorder = useRecorderStore.getState();
      const minDisp = useSettingsStore.getState().minDisplacementM;
      if (recorder.status === 'recording' && shouldRecord(this.lastFed, pos, minDisp)) {
        recorder.addPoint(trackPointFromFix(fix, pos, nowMs));
        this.lastFed = pos;
      }
    } else {
      this.lastFed = null;
    }
    if (nowMs - this.lastPublishMs < PUBLISH_MS && !outcome.decision.switched) return;
    this.lastPublishMs = nowMs;
    const datum = projectDatumOption(config.projectDatumId).datum;
    useGnssStore.getState().publish({
      fix,
      status,
      sky: this.pipeline.sky,
      map: { lat: pos.lat, lon: pos.lon, result: onMap },
      project: outputs.inProject(fix, corrections, datum, nowMs),
      use: outcome.use,
      phone: outcome.phone,
    });
  }

  private decide(nowMs: number) {
    const { config } = useGnssStore.getState();
    const outcome = arbitrate(
      this.source,
      this.connected || this.pipeline.fix ? this.pipeline.status : null,
      nowMs,
      {
        phoneWhileGood: config.phoneWhileGood,
        fallback: config.fallbackToPhone,
      },
    );
    this.source = outcome.state;
    return outcome;
  }

  private tick(): void {
    if (this.receiver === null) return;
    const nowMs = this.now();
    const status = this.pipeline.tick(nowMs);
    const outcome = this.decide(nowMs);
    if (outcome.use !== 'external') this.lastFed = null;
    this.ntrip.tick(this.pipeline.fix);
    useGnssStore.getState().publish({ status, use: outcome.use, phone: outcome.phone });
  }
}

function codeOf(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'code' in e)
    return String((e as { code: unknown }).code);
  return e instanceof Error ? e.message : String(e);
}

let session: GnssSession | null | undefined;

/** The app's receiver session, or null when this build can't use a receiver. */
export function gnssSession(): GnssSession | null {
  if (session !== undefined) return session;
  const link = gnssLink();
  session = link === null ? null : new GnssSession(link);
  return session;
}

/** Test-only. */
export function resetGnssSessionForTests(): void {
  session?.stop();
  session = undefined;
}
