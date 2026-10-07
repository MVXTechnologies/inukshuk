/**
 * The NTRIP client: one caster connection whose RTCM goes to the receiver,
 * plus the one-shot sourcetable fetch the profile editor browses. The
 * protocol is `@core/gnss/ntrip`; the socket is `@data/gnss/ntripSocket`
 * (native TCP when the binary has it, a simulated caster in debug / E2E
 * builds, else "needs an app update").
 */
import type { NtripProfile } from '@core/gnss/config';
import type { GnssFix } from '@core/gnss/fix';
import {
  buildGga,
  buildNtripRequest,
  ggaDecision,
  NtripConfigError,
  NtripResponseParser,
  type NtripStatus,
} from '@core/gnss/ntrip';
import type { FixKind } from '@core/gnss/quality';
import { parseSourcetable, type Sourcetable } from '@core/gnss/sourcetable';
import { asciiToBytes, bytesToAscii } from '@core/gnss/bytes';
import type { NtripSocket, NtripSocketFactory } from '@data/gnss/ntripSocket';
import type { NtripState } from '@state/gnssStore';

/** Wait this long before reconnecting to a caster that dropped us. */
export const NTRIP_RETRY_MS = 10_000;
/** Give up on a sourcetable after this long. */
export const SOURCETABLE_TIMEOUT_MS = 15_000;

export const NO_SOCKET_MESSAGE =
  'Corrections need the next app version: this one cannot open a connection to a caster';

/** Why a caster said no, in words (the head status the core decoded). */
export function ntripRefusal(status: NtripStatus, mountpoint: string): string {
  switch (status) {
    case 'unauthorized':
      return 'The caster refused the user name or password';
    case 'not-found':
    case 'sourcetable':
      return `The caster has no mountpoint “${mountpoint}”`;
    case 'bad-response':
      return 'That address did not answer like an NTRIP caster';
    default:
      return 'The caster answered with an error';
  }
}

/** The GGA quality indicator a fix kind is reported as. */
export function ggaQuality(kind: FixKind): number {
  switch (kind) {
    case 'rtk-fixed':
      return 4;
    case 'rtk-float':
      return 5;
    case 'dgps':
    case 'sbas':
      return 2;
    case 'autonomous':
      return 1;
    default:
      return 0;
  }
}

export interface NtripClientDeps {
  sockets: NtripSocketFactory | null;
  /** Forward RTCM to the receiver (the link's write). */
  toReceiver(bytes: Uint8Array): Promise<void>;
  publish(state: NtripState): void;
  now(): number;
}

export class NtripClient {
  private socket: NtripSocket | null = null;
  private parser: NtripResponseParser | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private profile: NtripProfile | null = null;
  private password = '';
  private lastGgaMs: number | null = null;
  private state: NtripState = { phase: 'off', message: null, bytes: 0, lastDataAtMs: null };
  private lastPublishMs = 0;

  constructor(private readonly deps: NtripClientDeps) {}

  /** Stream `profile`'s mountpoint (`password` from the secret store). */
  start(profile: NtripProfile, password: string, fix: GnssFix | null): void {
    this.stop();
    this.stopped = false;
    this.profile = profile;
    this.password = password;
    this.connect(fix);
  }

  stop(): void {
    this.stopped = true;
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    this.socket?.close();
    this.socket = null;
    this.parser = null;
    this.set({ phase: 'off', message: null, bytes: 0, lastDataAtMs: null }, true);
  }

  /** About once a second: upload the rover's position when the caster needs it and the user agreed. */
  tick(fix: GnssFix | null): void {
    const p = this.profile;
    if (this.stopped || p === null || this.socket === null || this.state.phase !== 'streaming')
      return;
    const nowMs = this.deps.now();
    const d = ggaDecision({
      nmeaRequired: p.needsGga,
      consent: p.ggaConsent,
      lastSentMs: this.lastGgaMs,
      nowMs,
      havePosition: fix !== null && fix.kind !== 'none',
    });
    if (!d.send || fix === null) return;
    this.lastGgaMs = nowMs;
    void this.socket.write(asciiToBytes(this.gga(fix, nowMs))).catch(() => undefined);
  }

  private gga(fix: GnssFix, nowMs: number): string {
    return buildGga({
      timeMs: fix.timeMs ?? nowMs,
      lat: fix.lat,
      lon: fix.lon,
      hEll: fix.hEll,
      quality: ggaQuality(fix.kind),
      satsUsed: fix.satsUsed,
      hdop: fix.hdop,
      ageS: fix.correctionAgeS,
    });
  }

  private connect(fix: GnssFix | null): void {
    const p = this.profile;
    if (p === null || this.stopped) return;
    if (this.deps.sockets === null) {
      this.set(
        { phase: 'unavailable', message: NO_SOCKET_MESSAGE, bytes: 0, lastDataAtMs: null },
        true,
      );
      return;
    }
    let request: Uint8Array;
    try {
      const sendGga =
        p.version === 2 && p.needsGga && p.ggaConsent && fix !== null && fix.kind !== 'none';
      request = buildNtripRequest(
        {
          host: p.host.trim(),
          port: p.port,
          mountpoint: p.mountpoint.trim(),
          version: p.version,
          username: p.username,
          password: this.password,
        },
        sendGga && fix ? { gga: this.gga(fix, this.deps.now()) } : {},
      );
    } catch (e) {
      const message = e instanceof NtripConfigError ? e.message : 'Invalid caster settings';
      this.set({ ...this.state, phase: 'error', message }, true);
      return;
    }
    this.set({ ...this.state, phase: 'connecting', message: null }, true);
    this.parser = new NtripResponseParser();
    this.lastGgaMs = null;
    const socket = this.deps.sockets.open(p.host.trim(), p.port, false, {
      onData: (bytes) => this.onData(socket, bytes),
      onClose: (err) => this.onClose(socket, err),
    });
    this.socket = socket;
    void socket.write(request).catch((e: unknown) => this.onClose(socket, String(e)));
  }

  private onData(socket: NtripSocket, bytes: Uint8Array): void {
    if (socket !== this.socket || this.parser === null || this.profile === null) return;
    const chunk = this.parser.push(bytes);
    const head = this.parser.head;
    if (head === null) return;
    if (head.status !== 'streaming') {
      const message = ntripRefusal(head.status, this.profile.mountpoint);
      this.socket = null;
      socket.close();
      // A refusal is not retried: wrong credentials stay wrong.
      this.set({ ...this.state, phase: 'error', message }, true);
      return;
    }
    const first = this.state.phase !== 'streaming';
    if (chunk.data.length > 0) {
      void this.deps.toReceiver(chunk.data).catch(() => undefined);
      this.set(
        {
          phase: 'streaming',
          message: null,
          bytes: this.state.bytes + chunk.data.length,
          lastDataAtMs: this.deps.now(),
        },
        first,
      );
    } else if (first) {
      this.set({ ...this.state, phase: 'streaming', message: null }, true);
    }
  }

  private onClose(socket: NtripSocket, err: string | null): void {
    if (socket !== this.socket || this.stopped) return;
    this.socket = null;
    this.set(
      { ...this.state, phase: 'error', message: err ?? 'The caster closed the connection' },
      true,
    );
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect(null);
    }, NTRIP_RETRY_MS);
  }

  /** Publish at most once a second while streaming; at once on a phase change. */
  private set(next: NtripState, force: boolean): void {
    this.state = next;
    const now = this.deps.now();
    if (!force && now - this.lastPublishMs < 1000) return;
    this.lastPublishMs = now;
    this.deps.publish(next);
  }
}

/**
 * Fetch a caster's sourcetable (the mountpoints it offers). Rejects with a
 * sentence the editor shows.
 */
export function fetchSourcetable(
  sockets: NtripSocketFactory | null,
  p: Pick<NtripProfile, 'host' | 'port' | 'version' | 'username'>,
  password: string,
): Promise<Sourcetable> {
  if (sockets === null) return Promise.reject(new Error(NO_SOCKET_MESSAGE));
  let request: Uint8Array;
  try {
    request = buildNtripRequest({
      host: p.host.trim(),
      port: p.port,
      mountpoint: '',
      version: p.version,
      username: p.username,
      password,
    });
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
  return new Promise<Sourcetable>((resolve, reject) => {
    const parser = new NtripResponseParser();
    let text = '';
    let settled = false;
    const finish = (err: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (err !== null) {
        reject(new Error(err));
        return;
      }
      const table = parseSourcetable(text);
      if (table.streams.length === 0) reject(new Error('The caster listed no mountpoints'));
      else resolve(table);
    };
    const timer = setTimeout(() => finish('The caster did not answer'), SOURCETABLE_TIMEOUT_MS);
    const socket = sockets.open(p.host.trim(), p.port, false, {
      onData: (bytes) => {
        const chunk = parser.push(bytes);
        const head = parser.head;
        if (head === null) return;
        if (head.status !== 'sourcetable') {
          finish(
            head.status === 'unauthorized'
              ? 'The caster refused the user name or password'
              : 'The caster did not send its list of mountpoints',
          );
          return;
        }
        text += bytesToAscii(chunk.data);
        if (chunk.done) finish(null);
      },
      onClose: (err) =>
        text !== '' && err === null
          ? finish(null)
          : finish(err ?? 'The caster closed the connection'),
    });
    void socket.write(request).catch((e: unknown) => finish(String(e)));
  });
}
