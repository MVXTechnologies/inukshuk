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
import { drawnPosition, FixOutputs, missingGrids, type GridEnv } from '@core/gnss/output';
import { projectDatumOption } from '@core/gnss/projectDatum';
import {
  arbitrate,
  INITIAL_SOURCE,
  isUbloxKit,
  kitSetupFrames,
  ReceiverPipeline,
  shouldRecord,
  trackPointFromFix,
  type MapPosition,
  type SourceState,
} from '@core/gnss/receiver';
import { gnssSecrets } from '@data/gnss/credentials';
import { rankDevices } from '@core/gnss/bleProfiles';
import { gnssLink, type GnssLink, type LinkDevice, type LinkSubscription } from '@data/gnss/link';
import { startReceiverStream, type ReceiverStream } from '@data/gnss/receiverStream';
import { connectOptions } from '@lib/gnss/nativeGnss';
import { ntripSocketFactory } from '@data/gnss/ntripSocket';
import { SIMULATED_INTERVAL_MS, simulatedFrames } from '@data/gnss/simulatedLink';
import { installedGrids } from '@data/projGrids';
import { initNativeProj, nativeEngine, nativeProjInfo } from '@lib/nativeProj';
import { useConvertStore } from '@state/convertStore';
import { reportError } from '@lib/errorReporting';
import { useGnssStore } from '@state/gnssStore';
import { useRecorderStore } from '@state/recorderStore';
import { useSettingsStore } from '@state/settingsStore';
import { Platform } from 'react-native';

import { NtripClient } from './ntripClient';

/** Silence check and source policy cadence. */
export const TICK_MS = 1000;
/** Publish fixes to the UI at most this often (a 10 Hz receiver needn't redraw 10×). */
export const PUBLISH_MS = 250;
/** After connecting, wait this long for UBX frames before deciding a receiver isn't a u-blox kit. */
export const KIT_SETUP_DELAY_MS = 3000;
/** How long a scan runs. */
export const SCAN_MS = 15_000;

/** The grids on this device, as Convert finds them (installed packs + the bundled directory). */
function gridEnv(): GridEnv {
  const bundledDir = nativeProjInfo()?.bundledGridDir;
  return { installed: installedGrids(), ...(bundledDir ? { bundledDir } : {}) };
}

function engine(): Engine {
  const e = nativeEngine();
  if (e) initNativeProj([]);
  return e ?? liteEngine;
}

/**
 * What the Bluetooth permission is called where the user grants it: Android
 * 12+ "Nearby devices"; Android 8–11 has no Bluetooth permission and gates BLE
 * scanning behind precise location; iOS "Bluetooth".
 */
export function permissionMessage(
  os: string = Platform.OS,
  version: number | string = Platform.Version,
): string {
  if (os === 'android' && Number(version) < 31) {
    return 'Android needs the precise-location permission to scan for Bluetooth receivers (Inukshuk uses it for nothing else)';
  }
  return os === 'android'
    ? 'Inukshuk needs the Nearby devices permission to reach the receiver'
    : 'Inukshuk needs Bluetooth access to reach the receiver';
}

/** A receiver error, in words. */
export function linkErrorMessage(code: string, fallback: string): string {
  switch (code) {
    case 'E_GNSS_BLUETOOTH_OFF':
      return 'Bluetooth is off — turn it on to use the receiver';
    case 'E_GNSS_PERMISSION':
      return permissionMessage();
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
  /** The native adapter feeding this connection's pipeline. */
  private stream: ReceiverStream | null = null;
  /** The u-blox kit setup was written on this connection. */
  private kitSetupSent = false;
  private kitSetupTimer: ReturnType<typeof setTimeout> | null = null;
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
  private unsubGrids: () => void = () => undefined;

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
    // A grid pack installed (Convert, or the sheet's download): re-plan with it.
    this.unsubGrids = useConvertStore.subscribe((st, prev) => {
      if (st.gridsVersion !== prev.gridsVersion && this.outputs !== null) {
        this.outputs = new FixOutputs(engine(), gridEnv());
      }
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
        store.publish({
          error: linkErrorMessage('E_GNSS_PERMISSION', ''),
          // Denied for good: only the system settings can grant it now.
          permissionBlocked: !perm.canAskAgain,
        });
        return;
      }
      store.publish({ permissionBlocked: false });
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
    // Known serial profiles first, then named devices, then signal (`@core/gnss/bleProfiles`).
    publish({ devices: rankDevices([...devices.filter((x) => x.id !== d.id), d]) });
  }

  // ---- the receiver -----------------------------------------------------------------------

  /** Connect to `receiver` and start using it. Idempotent for the same receiver. */
  start(receiver: PairedReceiver): void {
    if (this.receiver?.id === receiver.id && this.tickTimer !== null) return;
    this.stop();
    this.receiver = receiver;
    this.pipeline = new ReceiverPipeline();
    this.outputs = new FixOutputs(engine(), gridEnv());
    this.source = INITIAL_SOURCE;
    this.lastFed = null;
    this.kitSetupSent = false;
    // The native adapter: chunks in order into the pipeline's demuxer, reset
    // (and the assembler flushed) on every discontinuity — link drop, other
    // device, native overflow, a corrupt chunk (core README "Native transport").
    this.stream = startReceiverStream(this.link, this.pipeline.demuxer, {
      onFrames: (frames) => {
        const nowMs = this.now();
        for (const f of this.pipeline.events(frames, nowMs)) this.onFix(f, nowMs);
        this.maybeSetUpKit();
      },
      onState: (st) => this.onState(st.state, st.reason),
      onDiscontinuity: () => {
        const nowMs = this.now();
        for (const f of this.pipeline.flush(nowMs)) this.onFix(f, nowMs);
      },
    });
    useGnssStore.getState().publish({ link: 'connecting', error: null });
    // Silence is noticed without data: stale → lost (nextStatus), ~1 s.
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.link
      .connect(
        connectOptions({
          deviceId: receiver.id,
          transport: receiver.transport,
          autoReconnect: receiver.transport !== 'fake',
          // The native simulated receiver replays what it is given: the Québec session.
          ...(receiver.transport === 'fake'
            ? {
                fake: { frames: simulatedFrames(), intervalMs: SIMULATED_INTERVAL_MS, loop: true },
              }
            : {}),
        }),
      )
      .catch((e: unknown) => {
        useGnssStore.getState().publish({
          link: 'disconnected',
          error: linkErrorMessage(codeOf(e), 'Couldn’t connect to the receiver'),
        });
      });
  }

  /** Release everything (tests; the app keeps one session for its life). */
  dispose(): void {
    this.stop();
    this.unsubGrids();
    for (const s of this.subs) s.remove();
    this.subs = [];
  }

  /** Disconnect and hand the location back to the phone. */
  stop(): void {
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    this.tickTimer = null;
    for (const s of this.connSubs) s.remove();
    this.connSubs = [];
    this.stream?.stop();
    this.stream = null;
    if (this.kitSetupTimer !== null) clearTimeout(this.kitSetupTimer);
    this.kitSetupTimer = null;
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
    const connected = state === 'connected';
    if (this.connected && !connected) {
      // (The adapter already flushed the pipeline: onDiscontinuity.)
      this.ntrip.stop();
      this.ntripKey = '';
      this.kitSetupSent = false;
    }
    this.connected = connected;
    const link =
      state === 'connected' || state === 'connecting' || state === 'reconnecting'
        ? state
        : 'disconnected';
    useGnssStore.getState().publish({ link, linkReason: reason });
    if (connected) {
      void this.refreshCorrections().catch((e) => reportError(e, 'gnss-ntrip'));
      this.maybeSetUpKit();
      // A kit that speaks UBX but isn't named like one: look again once data flows.
      if (this.kitSetupTimer !== null) clearTimeout(this.kitSetupTimer);
      this.kitSetupTimer = setTimeout(() => this.maybeSetUpKit(), KIT_SETUP_DELAY_MS);
    }
    this.tick();
  }

  /**
   * After connecting a u-blox kit: write the minimal setup (RTCM in, UBX NAV +
   * NMEA out, RAM only) once per connection; its ACKs are counted by the
   * pipeline and published as `kitSetup`.
   */
  private maybeSetUpKit(): void {
    const r = this.receiver;
    if (r === null || !this.connected || this.kitSetupSent || r.transport === 'fake') return;
    if (!isUbloxKit(r.name, this.pipeline.counters)) return;
    this.kitSetupSent = true;
    void (async () => {
      try {
        for (const frame of kitSetupFrames()) await this.link.write(frame);
        useGnssStore.getState().publish({ kitSetup: 'sent' });
      } catch (e) {
        this.kitSetupSent = false;
        reportError(e, 'gnss-kit-setup');
      }
    })();
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
    const project = outputs.inProject(fix, corrections, datum, nowMs);
    useGnssStore.getState().publish({
      fix,
      status,
      sky: this.pipeline.sky,
      map: { lat: pos.lat, lon: pos.lon, result: onMap },
      project,
      projectFallback:
        missingGrids(project).length > 0
          ? outputs.inFallback(fix, corrections, datum, nowMs)
          : null,
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
    const c = this.pipeline.counters;
    useGnssStore.getState().publish({
      status,
      use: outcome.use,
      phone: outcome.phone,
      ...(this.kitSetupSent && (c.cfgAck > 0 || c.cfgNak > 0)
        ? { kitSetup: c.cfgNak > 0 ? 'refused' : 'ok' }
        : {}),
    });
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
  session?.dispose();
  session = undefined;
}
