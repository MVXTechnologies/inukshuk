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
import { caseVariant, parseSourcetable, type Sourcetable } from '@core/gnss/sourcetable';
import { asciiToBytes, bytesToAscii } from '@core/gnss/bytes';
import type { NtripSocket, NtripSocketFactory } from '@data/gnss/ntripSocket';
import type { NtripState } from '@state/gnssStore';

/** Wait this long before reconnecting to a caster that dropped us. */
export const NTRIP_RETRY_MS = 10_000;
/** Give up on a sourcetable after this long. */
export const SOURCETABLE_TIMEOUT_MS = 15_000;

export const NO_SOCKET_MESSAGE =
  'Corrections need the next app version: this one cannot open a connection to a caster';

/**
 * A caster that has not answered this long after the request may be waiting
 * for the rover's position before it answers (some VRS casters on v1): the
 * GGA then goes out without waiting for the reply.
 */
export const GGA_BEFORE_REPLY_MS = 2_000;
/** How long a "no such mountpoint" sourcetable is read for a case-only match. */
export const REFUSAL_READ_MS = 3_000;

/**
 * Why a caster said no, in words (the head status the core decoded).
 * `listed`: the caster's spelling of the mountpoint when it differs only in case.
 */
export function ntripRefusal(
  status: NtripStatus,
  mountpoint: string,
  listed: string | null = null,
): string {
  switch (status) {
    case 'unauthorized':
      return 'The caster refused the user name or password';
    case 'not-found':
    case 'sourcetable':
      return listed !== null
        ? `The caster has no mountpoint “${mountpoint}” · it lists “${listed}” (capitals matter)`
        : `The caster has no mountpoint “${mountpoint}”`;
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
  /** The latest rover fix (from `start` / `tick`), for the GGA upload. */
  private fix: GnssFix | null = null;
  /** When the request went out, ms. */
  private requestAtMs = 0;
  /** A "no such mountpoint" sourcetable being read for a case-only match. */
  private refusal: { text: string; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(private readonly deps: NtripClientDeps) {}

  /** Stream `profile`'s mountpoint (`password` from the secret store). */
  start(profile: NtripProfile, password: string, fix: GnssFix | null): void {
    this.stop();
    this.stopped = false;
    this.profile = profile;
    this.password = password;
    this.fix = fix;
    this.connect(fix);
  }

  stop(): void {
    this.stopped = true;
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    this.endRefusal();
    this.socket?.close();
    this.socket = null;
    this.parser = null;
    this.set({ phase: 'off', message: null, bytes: 0, lastDataAtMs: null }, true);
  }

  /**
   * About once a second: upload the rover's position when the user agreed
   * (every GGA_INTERVAL_S while streaming; before the reply too when the
   * caster stays silent, as some wait for a position before answering).
   */
  tick(fix: GnssFix | null): void {
    this.fix = fix;
    if (this.state.phase === 'streaming') this.sendGga();
    else if (
      this.state.phase === 'connecting' &&
      this.deps.now() - this.requestAtMs >= GGA_BEFORE_REPLY_MS
    )
      this.sendGga();
  }

  private sendGga(): void {
    const p = this.profile;
    const fix = this.fix;
    if (this.stopped || p === null || this.socket === null) return;
    const nowMs = this.deps.now();
    const d = ggaDecision({
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
      const sendGga = p.version === 2 && p.ggaConsent && fix !== null && fix.kind !== 'none';
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
    const socket = this.deps.sockets.open(p.host.trim(), p.port, p.port === 443, {
      onData: (bytes) => this.onData(socket, bytes),
      onClose: (err) => this.onClose(socket, err),
    });
    this.socket = socket;
    this.requestAtMs = this.deps.now();
    void socket.write(request).catch((e: unknown) => this.onClose(socket, String(e)));
  }

  private onData(socket: NtripSocket, bytes: Uint8Array): void {
    if (socket !== this.socket || this.parser === null || this.profile === null) return;
    const chunk = this.parser.push(bytes);
    const head = this.parser.head;
    if (head === null) return;
    if (head.status === 'sourcetable') {
      // A v1 caster's "no such mountpoint": read its list to spot a case-only mismatch.
      if (this.refusal === null) {
        this.refusal = {
          text: '',
          timer: setTimeout(() => this.refuse(socket, 'sourcetable'), REFUSAL_READ_MS),
        };
      }
      this.refusal.text += bytesToAscii(chunk.data);
      if (chunk.done) this.refuse(socket, 'sourcetable');
      return;
    }
    if (head.status !== 'streaming') {
      this.refuse(socket, head.status);
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
    // v1 casters ignore the request's Ntrip-GGA header: the position goes in-band at once.
    if (first) this.sendGga();
  }

  /** The caster said no: in words, and not retried (wrong credentials stay wrong). */
  private refuse(socket: NtripSocket, status: NtripStatus): void {
    if (socket !== this.socket || this.profile === null) return;
    const text = this.refusal?.text ?? '';
    this.endRefusal();
    const mount = this.profile.mountpoint.trim();
    const listed = text === '' ? null : caseVariant(parseSourcetable(text).streams, mount);
    this.socket = null;
    socket.close();
    this.set({ ...this.state, phase: 'error', message: ntripRefusal(status, mount, listed) }, true);
  }

  private endRefusal(): void {
    if (this.refusal !== null) clearTimeout(this.refusal.timer);
    this.refusal = null;
  }

  private onClose(socket: NtripSocket, err: string | null): void {
    if (socket !== this.socket || this.stopped) return;
    if (this.refusal !== null) {
      this.refuse(socket, 'sourcetable');
      return;
    }
    this.socket = null;
    this.set(
      { ...this.state, phase: 'error', message: err ?? 'The caster closed the connection' },
      true,
    );
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect(this.fix);
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
    const socket = sockets.open(p.host.trim(), p.port, p.port === 443, {
      onData: (bytes) => {
        const chunk = parser.push(bytes);
        const head = parser.head;
        if (head === null) return;
        // Some casters label the list text/plain on an HTTP 200: still the list asked for.
        const listed =
          head.status === 'sourcetable' ||
          (head.status === 'streaming' && head.protocol.startsWith('HTTP'));
        if (!listed) {
          finish(
            head.status === 'unauthorized'
              ? 'The caster refused the user name or password'
              : 'The caster did not send its list of mountpoints',
          );
          return;
        }
        text += bytesToAscii(chunk.data);
        if (chunk.done || /ENDSOURCETABLE\r?\n/.test(text)) finish(null);
      },
      onClose: (err) =>
        text !== '' && err === null
          ? finish(null)
          : finish(err ?? 'The caster closed the connection'),
    });
    void socket.write(request).catch((e: unknown) => finish(String(e)));
  });
}
