/**
 * WebRTC data channels as a link-layer {@link Carrier} (2.7.0 design §2.2 and
 * §2.4, security review §2.5, #705): one `RTCPeerConnection` per attempt to a
 * remote phone, one ordered, reliable channel `s` carrying link-mux frames.
 *
 * - **Signalling (R-RTC-1):** the offer, the answer and every candidate go
 *   out only through `signal`, which the path manager sends inside the
 *   authenticated L0 session; nothing here talks to a server.
 * - **No host candidates (R-RTC-3):** a private LAN address never leaves,
 *   neither in the SDP nor trickled, and a peer's host candidates are not
 *   used; a `relay` attempt (forced or "Always use the relay", R-RTC-6) keeps
 *   TURN candidates only and runs with `iceTransportPolicy: 'relay'`.
 * - **Fingerprint binding (R-RTC-2):** once the channel opens, the DTLS
 *   certificate the transport negotiated (from `getStats`) must equal the
 *   `a=fingerprint` of the SDP the authenticated session carried, or the
 *   attempt closes. Only then is the connection announced to the link layer,
 *   whose first session must authenticate the same member as L0.
 * - **Path:** read from the selected candidate pair (`relay` when either end
 *   is TURN), not assumed from what was asked.
 * - **Shallow queue (design §4.4):** `inFlight` is the channel's
 *   `bufferedAmount`; `writable` fires when it falls under half the budget.
 *
 * Total toward the native layer: a throw or rejection from it ends that
 * attempt, never the app.
 */
import {
  IN_FLIGHT_BUDGET,
  type Carrier,
  type CarrierConn,
  type CarrierEvent,
  type SendResult,
} from '@core/group/link';
import type { Lane } from '@core/group/lanes';
import type { IceServer } from '@core/group/roomProto';
import {
  allowCandidate,
  filterSdpCandidates,
  sdpFingerprintBinding,
  selectedPathKind,
  type IcePolicy,
} from '@core/group/sdp';
import type { RtcSignal } from '@core/team/sync';

import type { Timers } from '../linkHost';

import type { RtcDataChannelLike, RtcModuleLike, RtcPeerConnectionLike } from './rtcModule';

/** WebRTC's safe message size (design §2.2). */
export const RTC_MAX_FRAME_BYTES = 64 * 1024;
/** Past this much buffered, `send` refuses (backpressure) whatever the link's own budget. */
export const RTC_HARD_BUFFER_BYTES = 8 * 1024 * 1024;
/** Largest SDP an attempt will signal (it must fit one room blob with its session framing). */
export const RTC_MAX_SDP = 12 * 1024;
/** The sync channel's label. */
export const SYNC_CHANNEL = 's';

/** A connection to one remote member over one attempt. */
export interface RtcConn extends CarrierConn {
  readonly member: string;
}

export type AttemptEvent =
  | { type: 'ready'; conn: RtcConn }
  | { type: 'failed'; reason: string }
  | { type: 'closed'; reason: string };

export interface AttemptOptions {
  member: string;
  /** What this attempt may reveal and use: `direct` (public + relay) or `relay` only. */
  policy: IcePolicy;
  iceServers: IceServer[];
  /** Hand a signal to the authenticated L0 session; false when it couldn't go. */
  signal(s: RtcSignal): boolean;
  /** Fail when not connected (and verified) within this long. */
  timeoutMs: number;
}

export interface RtcCarrierOptions {
  module: RtcModuleLike;
  timers: Timers;
  /** An attempt's progress (the path manager's input). */
  onAttempt(attemptId: string, member: string, e: AttemptEvent): void;
  onDiag?(event: string): void;
  budget?: number;
}

interface Attempt {
  readonly id: string;
  readonly member: string;
  readonly role: 'offer' | 'answer';
  readonly policy: IcePolicy;
  readonly signal: (s: RtcSignal) => boolean;
  readonly pc: RtcPeerConnectionLike;
  dc: RtcDataChannelLike | null;
  remoteSdp: string | null;
  /** The remote description is applied: candidates may be added. */
  remoteApplied: boolean;
  /** Remote candidates that arrived before the remote description was applied. */
  early: RtcSignal[];
  state: 'negotiating' | 'verifying' | 'open' | 'closed';
  timer: unknown;
  conn: RtcConn | null;
}

export class RtcCarrier implements Carrier {
  readonly kind = 'rtc' as const;
  private readonly listeners = new Set<(e: CarrierEvent) => void>();
  private readonly attempts = new Map<string, Attempt>();
  private next = 1;

  constructor(private readonly o: RtcCarrierOptions) {}

  subscribe(l: (e: CarrierEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(e: CarrierEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        // A listener's failure must not break the carrier.
      }
    }
  }

  private diag(event: string): void {
    this.o.onDiag?.(event);
  }

  /** Attempts still negotiating or open, per member (the path manager's view). */
  live(member: string): { id: string; state: Attempt['state']; role: Attempt['role'] }[] {
    return [...this.attempts.values()]
      .filter((a) => a.member === member && a.state !== 'closed')
      .map((a) => ({ id: a.id, state: a.state, role: a.role }));
  }

  /** Start an attempt toward `member` as the offering side. Returns its id. */
  dial(o: AttemptOptions): string {
    const a = this.create(o, 'offer');
    if (a === null) return '';
    try {
      const dc = a.pc.createDataChannel(SYNC_CHANNEL, { ordered: true });
      this.bindChannel(a, dc);
    } catch {
      this.fail(a, 'native');
      return a.id;
    }
    void (async () => {
      try {
        const offer = await a.pc.createOffer();
        if (this.gone(a)) return;
        await a.pc.setLocalDescription(offer);
        if (this.gone(a)) return;
        this.sendSdp(a, 'offer', offer.sdp);
      } catch {
        this.fail(a, 'offer');
      }
    })();
    return a.id;
  }

  /** Answer `member`'s offer (it arrived through the authenticated session). Returns the attempt id. */
  answer(o: AttemptOptions, offerSdp: string): string {
    const a = this.create(o, 'answer');
    if (a === null) return '';
    a.remoteSdp = offerSdp;
    void (async () => {
      try {
        await a.pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
        if (this.gone(a)) return;
        a.remoteApplied = true;
        await this.flushEarly(a);
        const answer = await a.pc.createAnswer();
        if (this.gone(a)) return;
        await a.pc.setLocalDescription(answer);
        if (this.gone(a)) return;
        this.sendSdp(a, 'answer', answer.sdp);
      } catch {
        this.fail(a, 'answer');
      }
    })();
    return a.id;
  }

  /**
   * A signal from `member` (an answer or a candidate; an offer goes to
   * {@link answer}) for its newest negotiating attempt.
   */
  onSignal(member: string, s: RtcSignal): void {
    const a = [...this.attempts.values()]
      .reverse()
      .find((x) => x.member === member && x.state === 'negotiating');
    if (a === undefined) return;
    if (s.k === 'answer') {
      if (a.role !== 'offer' || a.remoteSdp !== null) return;
      a.remoteSdp = s.sdp;
      void (async () => {
        try {
          await a.pc.setRemoteDescription({ type: 'answer', sdp: s.sdp });
          if (this.gone(a)) return;
          a.remoteApplied = true;
          await this.flushEarly(a);
        } catch {
          this.fail(a, 'answer');
        }
      })();
      return;
    }
    if (s.k !== 'ice') return;
    if (!a.remoteApplied) {
      if (a.early.length < 64) a.early.push(s);
      return;
    }
    void this.addCandidate(a, s);
  }

  /** Close one attempt (a path the path manager no longer wants). */
  close(attemptId: string, why: string): void {
    const a = this.attempts.get(attemptId);
    if (a !== undefined) this.end(a, why, 'closed');
  }

  /** Close every attempt to a member (removed, banned, signalling lost). */
  closeMember(member: string, why: string): void {
    for (const a of [...this.attempts.values()])
      if (a.member === member) this.end(a, why, 'closed');
  }

  closeAll(why: string): void {
    for (const a of [...this.attempts.values()]) this.end(a, why, 'closed');
  }

  // ── Attempts ──────────────────────────────────────────────────────────────

  private create(o: AttemptOptions, role: Attempt['role']): Attempt | null {
    let pc: RtcPeerConnectionLike;
    try {
      pc = new this.o.module.RTCPeerConnection({
        iceServers: o.iceServers,
        iceTransportPolicy: o.policy === 'relay' ? 'relay' : 'all',
        bundlePolicy: 'max-bundle',
      });
    } catch {
      this.diag('rtc unavailable');
      this.o.onAttempt('', o.member, { type: 'failed', reason: 'native' });
      return null;
    }
    const a: Attempt = {
      id: `rtc-${this.next++}`,
      member: o.member,
      role,
      policy: o.policy,
      signal: o.signal,
      pc,
      dc: null,
      remoteSdp: null,
      remoteApplied: false,
      early: [],
      state: 'negotiating',
      timer: null,
      conn: null,
    };
    this.attempts.set(a.id, a);
    a.timer = this.o.timers.setTimeout(() => {
      a.timer = null;
      if (a.state === 'negotiating' || a.state === 'verifying') this.fail(a, 'timeout');
    }, o.timeoutMs);
    pc.addEventListener(
      'icecandidate',
      (ev: {
        candidate?: {
          candidate?: string;
          sdpMid?: string | null;
          sdpMLineIndex?: number | null;
        } | null;
      }) => {
        const c = ev?.candidate;
        if (a.state !== 'negotiating' || c == null || typeof c.candidate !== 'string') return;
        // R-RTC-3: never a private address over the internet path.
        if (c.candidate === '' || !allowCandidate(c.candidate, a.policy)) return;
        const s: RtcSignal = { k: 'ice', c: c.candidate };
        if (typeof c.sdpMid === 'string') s.mid = c.sdpMid;
        if (typeof c.sdpMLineIndex === 'number') s.ix = c.sdpMLineIndex;
        a.signal(s);
      },
    );
    pc.addEventListener('connectionstatechange', () => {
      if (this.gone(a)) return;
      const st = pc.connectionState;
      if (st === 'failed' || st === 'closed') this.fail(a, `ice-${st}`);
    });
    pc.addEventListener('datachannel', (ev: { channel?: RtcDataChannelLike }) => {
      const dc = ev?.channel;
      if (a.role !== 'answer' || a.dc !== null || dc === undefined || dc.label !== SYNC_CHANNEL) {
        try {
          dc?.close();
        } catch {
          // Gone already.
        }
        return;
      }
      this.bindChannel(a, dc);
    });
    return a;
  }

  private sendSdp(a: Attempt, k: 'offer' | 'answer', sdp: string): void {
    const filtered = filterSdpCandidates(sdp, a.policy);
    if (filtered.length > RTC_MAX_SDP || !a.signal({ k, sdp: filtered })) {
      this.fail(a, 'signal');
    }
  }

  private async flushEarly(a: Attempt): Promise<void> {
    for (const s of a.early.splice(0)) await this.addCandidate(a, s);
  }

  private async addCandidate(a: Attempt, s: RtcSignal): Promise<void> {
    if (s.k !== 'ice' || a.state === 'closed') return;
    // A peer's private addresses are refused too (R-RTC-3); the empty
    // candidate (end of candidates) passes.
    if (!allowCandidate(s.c, 'direct')) return;
    try {
      await a.pc.addIceCandidate({
        candidate: s.c,
        ...(s.mid !== undefined ? { sdpMid: s.mid } : {}),
        ...(s.ix !== undefined ? { sdpMLineIndex: s.ix } : {}),
      });
    } catch {
      // A candidate the stack refuses is just not used.
    }
  }

  private bindChannel(a: Attempt, dc: RtcDataChannelLike): void {
    a.dc = dc;
    try {
      dc.binaryType = 'arraybuffer';
      dc.bufferedAmountLowThreshold = (this.o.budget ?? IN_FLIGHT_BUDGET) / 2;
    } catch {
      // Defaults are fine.
    }
    dc.addEventListener('open', () => void this.verify(a));
    dc.addEventListener('close', () => this.end(a, 'channel-closed', 'closed'));
    dc.addEventListener('message', (ev: { data?: unknown }) => {
      if (a.state !== 'open' || a.conn === null) return;
      const data = ev?.data;
      if (data instanceof ArrayBuffer) {
        this.emit({ type: 'frame', connId: a.id, data: new Uint8Array(data) });
      } else if (ArrayBuffer.isView(data)) {
        this.emit({
          type: 'frame',
          connId: a.id,
          data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice(),
        });
      } else {
        // Text on a binary channel is not ours.
        this.end(a, 'protocol', 'closed');
      }
    });
    dc.addEventListener('bufferedamountlow', () => {
      if (a.state === 'open') this.emit({ type: 'writable', connId: a.id });
    });
  }

  /** R-RTC-2: the negotiated certificate must be the one the authenticated SDP named. */
  private async verify(a: Attempt): Promise<void> {
    if (a.state !== 'negotiating' || a.remoteSdp === null) return this.fail(a, 'no-sdp');
    a.state = 'verifying';
    let stats: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
    try {
      stats = await a.pc.getStats();
    } catch {
      return this.fail(a, 'stats');
    }
    if (a.state !== 'verifying') return;
    const binding = sdpFingerprintBinding(a.remoteSdp, stats);
    if (!binding.ok) {
      this.diag(`rtc fingerprint ${binding.reason}`);
      return this.fail(a, `fingerprint-${binding.reason}`);
    }
    const path = selectedPathKind(stats) ?? a.policy;
    if (a.timer !== null) this.o.timers.clearTimeout(a.timer);
    a.timer = null;
    a.state = 'open';
    const dc = a.dc!;
    const conn: RtcConn = {
      connId: a.id,
      path,
      member: a.member,
      maxFrameBytes: RTC_MAX_FRAME_BYTES,
      send: (frame: Uint8Array, _lane: Lane): SendResult => {
        if (a.state !== 'open' || dc.readyState !== 'open') return 'closed';
        if (dc.bufferedAmount > RTC_HARD_BUFFER_BYTES) return 'backpressure';
        try {
          dc.send(frame);
          return 'ok';
        } catch {
          this.end(a, 'send', 'closed');
          return 'closed';
        }
      },
      close: (why: string) => this.end(a, why, 'closed'),
      inFlight: () => {
        try {
          return dc.bufferedAmount;
        } catch {
          return 0;
        }
      },
    };
    a.conn = conn;
    this.diag(`rtc open ${path}`);
    this.o.onAttempt(a.id, a.member, { type: 'ready', conn });
    this.emit({ type: 'conn', conn, direction: a.role === 'offer' ? 'out' : 'in' });
  }

  /** Ended (read through a call: the state changes across awaits). */
  private gone(a: Attempt): boolean {
    return a.state === 'closed';
  }

  private fail(a: Attempt, reason: string): void {
    this.end(a, reason, 'failed');
  }

  private end(a: Attempt, reason: string, kind: 'failed' | 'closed'): void {
    if (this.gone(a)) return;
    const wasOpen = a.conn !== null;
    a.state = 'closed';
    this.attempts.delete(a.id);
    if (a.timer !== null) this.o.timers.clearTimeout(a.timer);
    a.timer = null;
    try {
      a.dc?.close();
    } catch {
      // Gone already.
    }
    try {
      a.pc.close();
    } catch {
      // Gone already.
    }
    this.diag(`rtc ${kind} ${reason.slice(0, 24)}`);
    this.o.onAttempt(a.id, a.member, { type: wasOpen ? 'closed' : kind, reason });
    if (wasOpen) this.emit({ type: 'closed', connId: a.id, reason });
  }
}
