/**
 * An in-memory `react-native-webrtc` for the data-layer tests (G6): peer
 * connections that gather host / srflx / relay candidates, connect when the
 * network model allows (direct across NATs, or through TURN), open the `s`
 * data channel on both ends and report `getStats` the way the real stack
 * does (transport → certificate → fingerprint, selected candidate pair).
 * Deliveries go through the test's scheduler.
 *
 * Knobs: `directWorks` (NATs allow srflx↔srflx), `relayWorks` (TURN
 * reachable), `mitm` (the transport negotiates a certificate other than the
 * one its SDP named, as a signalling MITM would make it).
 */
import type {
  RtcConfiguration,
  RtcDataChannelLike,
  RtcIceCandidateInit,
  RtcModuleLike,
  RtcPeerConnectionLike,
  RtcSessionDescriptionLike,
} from '../carriers/rtcModule';

type Listener = (event: any) => void;

class Target {
  private readonly listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, l: Listener): void {
    let set = this.listeners.get(type);
    if (set === undefined) this.listeners.set(type, (set = new Set()));
    set.add(l);
  }
  removeEventListener(type: string, l: Listener): void {
    this.listeners.get(type)?.delete(l);
  }
  dispatch(type: string, event: unknown = {}): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) l(event);
  }
}

const hex = (n: number) =>
  Array.from({ length: 32 }, (_, i) => ((n * 31 + i * 7) & 255).toString(16).padStart(2, '0'))
    .join(':')
    .toUpperCase();

export class FakeRtcNetwork {
  directWorks = true;
  relayWorks = true;
  mitm = false;
  /** Every candidate any PC was given by its peer (to prove no host candidate crossed). */
  readonly remoteCandidates: string[] = [];
  readonly pcs: FakePeerConnection[] = [];
  private nextId = 1;

  /** What `require('react-native-webrtc')` would give. */
  readonly module: RtcModuleLike;

  constructor(readonly schedule: (fn: () => void) => void) {
    const create = (config: RtcConfiguration) => this.create(config);
    this.module = {
      // `new RTCPeerConnection(config)` returns the fake (a constructor may return an object).
      RTCPeerConnection: function FakeRTCPeerConnection(config: RtcConfiguration) {
        return create(config);
      } as unknown as RtcModuleLike['RTCPeerConnection'],
    };
  }

  create(config: RtcConfiguration): FakePeerConnection {
    const pc = new FakePeerConnection(this, this.nextId++, config);
    this.pcs.push(pc);
    return pc;
  }

  byId(id: number): FakePeerConnection | undefined {
    return this.pcs.find((p) => p.id === id);
  }

  /** Both ends described and candidates exchanged: connect if a pair works. */
  check(a: FakePeerConnection): void {
    const b = a.peer;
    if (
      b === undefined ||
      b.peer !== a ||
      a.connectionState !== 'new' ||
      b.connectionState !== 'new'
    )
      return;
    if (!a.described || !b.described) return;
    const pair = this.pair(a, b);
    if (pair === null) return;
    a.connectionState = 'connecting';
    b.connectionState = 'connecting';
    this.schedule(() => {
      if (a.closed || b.closed) return;
      a.connect(pair[0], pair[1]);
      b.connect(pair[1], pair[0]);
    });
  }

  /** The candidate types a working pair would use, as seen from `a`. */
  private pair(a: FakePeerConnection, b: FakePeerConnection): [string, string] | null {
    const relayA = a.localTypes.has('relay') && this.relayWorks;
    const relayB = b.localTypes.has('relay') && this.relayWorks;
    const aHears = (t: string) => a.remoteTypes.has(t);
    const bHears = (t: string) => b.remoteTypes.has(t);
    if (
      this.directWorks &&
      a.localTypes.has('srflx') &&
      b.localTypes.has('srflx') &&
      aHears('srflx') &&
      bHears('srflx')
    ) {
      return ['srflx', 'srflx'];
    }
    if (relayA && bHears('relay'))
      return ['relay', aHears('relay') ? 'relay' : aHears('srflx') ? 'srflx' : 'none'];
    if (relayB && aHears('relay')) return [bHears('srflx') ? 'srflx' : 'none', 'relay'];
    return null;
  }
}

export class FakeDataChannel extends Target implements RtcDataChannelLike {
  readyState = 'connecting';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType = 'blob';
  other: FakeDataChannel | undefined;
  /** Bytes sent through this end. */
  sentBytes = 0;

  constructor(
    readonly label: string,
    private readonly schedule: (fn: () => void) => void,
  ) {
    super();
  }

  send(data: ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== 'open') throw new Error('not open');
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data).slice()
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
    this.bufferedAmount += bytes.length;
    this.sentBytes += bytes.length;
    this.schedule(() => {
      const before = this.bufferedAmount;
      this.bufferedAmount -= bytes.length;
      if (
        before > this.bufferedAmountLowThreshold &&
        this.bufferedAmount <= this.bufferedAmountLowThreshold
      ) {
        this.dispatch('bufferedamountlow');
      }
      if (this.other?.readyState === 'open') this.other.dispatch('message', { data: bytes.buffer });
    });
  }

  open(): void {
    this.readyState = 'open';
    this.dispatch('open');
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.schedule(() => this.dispatch('close'));
    const o = this.other;
    if (o && o.readyState !== 'closed') {
      o.readyState = 'closed';
      this.schedule(() => o.dispatch('close'));
    }
  }
}

export class FakePeerConnection extends Target implements RtcPeerConnectionLike {
  connectionState = 'new';
  readonly cert: string;
  local: RtcSessionDescriptionLike | null = null;
  remote: RtcSessionDescriptionLike | null = null;
  peer: FakePeerConnection | undefined;
  readonly localTypes = new Set<string>();
  readonly remoteTypes = new Set<string>();
  dc: FakeDataChannel | undefined;
  closed = false;
  private pair: [string, string] = ['none', 'none'];

  constructor(
    private readonly net: FakeRtcNetwork,
    readonly id: number,
    readonly config: RtcConfiguration,
  ) {
    super();
    this.cert = hex(id);
  }

  get described(): boolean {
    return this.local !== null && this.remote !== null;
  }

  createDataChannel(label: string): RtcDataChannelLike {
    this.dc = new FakeDataChannel(label, this.net.schedule);
    return this.dc;
  }

  private sdp(type: string): RtcSessionDescriptionLike {
    return {
      type,
      sdp: [
        'v=0',
        `o=- ${this.id} 2 IN IP4 127.0.0.1`,
        'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
        `a=ice-ufrag:pc${this.id}`,
        `a=fingerprint:sha-256 ${this.cert}`,
        // A host candidate baked into the SDP: the carrier must strip it.
        `a=candidate:9 1 udp 2122260223 10.0.0.${this.id} 50000 typ host`,
        '',
      ].join('\r\n'),
    };
  }

  async createOffer(): Promise<RtcSessionDescriptionLike> {
    return this.sdp('offer');
  }

  async createAnswer(): Promise<RtcSessionDescriptionLike> {
    return this.sdp('answer');
  }

  async setLocalDescription(d: RtcSessionDescriptionLike): Promise<void> {
    this.local = d;
    this.net.schedule(() => this.gather());
    this.net.check(this);
  }

  async setRemoteDescription(d: RtcSessionDescriptionLike): Promise<void> {
    this.remote = d;
    const m = /a=ice-ufrag:pc(\d+)/.exec(d.sdp);
    this.peer = m ? this.net.byId(Number(m[1])) : undefined;
    for (const line of d.sdp.split(/\r?\n/)) {
      if (line.startsWith('a=candidate:')) this.hear(line.slice(2));
    }
    this.net.check(this);
  }

  private gather(): void {
    if (this.closed) return;
    const emit = (c: string) =>
      this.dispatch('icecandidate', { candidate: { candidate: c, sdpMid: '0', sdpMLineIndex: 0 } });
    const turn = this.config.iceServers.some((s) => s.username !== undefined);
    const all = this.config.iceTransportPolicy === 'all';
    if (all) {
      this.localTypes.add('host');
      emit(`candidate:1 1 udp 2122260223 10.0.0.${this.id} 50000 typ host generation 0`);
      this.localTypes.add('srflx');
      emit(
        `candidate:2 1 udp 1686052607 203.0.113.${this.id} 4000 typ srflx raddr 10.0.0.${this.id} rport 50000`,
      );
    }
    if (turn) {
      this.localTypes.add('relay');
      emit(
        `candidate:3 1 udp 41885439 198.51.100.${this.id} 3478 typ relay raddr 203.0.113.${this.id} rport 4000`,
      );
    }
    this.dispatch('icecandidate', { candidate: null });
    this.net.check(this);
    if (this.peer) this.net.check(this.peer);
  }

  private hear(candidate: string): void {
    this.net.remoteCandidates.push(candidate);
    const t = / typ (\w+)/.exec(candidate)?.[1];
    if (t !== undefined) this.remoteTypes.add(t);
  }

  async addIceCandidate(c: RtcIceCandidateInit): Promise<void> {
    if (this.remote === null) throw new Error('no remote description');
    if (c.candidate !== '') this.hear(c.candidate);
    this.net.check(this);
    if (this.peer) this.net.check(this.peer);
  }

  connect(local: string, remote: string): void {
    this.pair = [local, remote];
    this.connectionState = 'connected';
    this.dispatch('connectionstatechange');
    const peer = this.peer!;
    if (this.dc === undefined) {
      // The answering side learns of the offerer's channel.
      this.dc = new FakeDataChannel(peer.dc?.label ?? 's', this.net.schedule);
      this.dispatch('datachannel', { channel: this.dc });
    }
    if (peer.dc !== undefined && this.dc !== undefined) {
      this.dc.other = peer.dc;
      peer.dc.other = this.dc;
    }
    const dc = this.dc;
    this.net.schedule(() => {
      if (!this.closed && dc.readyState === 'connecting') dc.open();
    });
  }

  async getStats(): Promise<ReadonlyMap<string, Readonly<Record<string, unknown>>>> {
    const remoteCert = this.net.mitm ? hex(999) : (this.peer?.cert ?? '');
    const connected = this.connectionState === 'connected';
    return new Map<string, Record<string, unknown>>([
      [
        'T',
        {
          id: 'T',
          type: 'transport',
          dtlsState: connected ? 'connected' : 'new',
          remoteCertificateId: 'RC',
          selectedCandidatePairId: 'P',
        },
      ],
      [
        'RC',
        { id: 'RC', type: 'certificate', fingerprintAlgorithm: 'sha-256', fingerprint: remoteCert },
      ],
      ['P', { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R' }],
      ['L', { id: 'L', type: 'local-candidate', candidateType: this.pair[0] }],
      ['R', { id: 'R', type: 'remote-candidate', candidateType: this.pair[1] }],
    ]);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connectionState = 'closed';
    this.dc?.close();
  }
}
