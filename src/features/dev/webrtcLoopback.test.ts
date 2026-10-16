import {
  formatSpikeReport,
  runDataChannelLoopback,
  tamperFingerprint,
  type RtcDataChannelLike,
  type RtcPeerConnectionLike,
  type RtcSessionDescriptionLike,
  type WebRtcModuleLike,
} from './webrtcLoopback';

class FakeTarget {
  private listeners = new Map<string, Set<(e: any) => void>>();
  addEventListener(type: string, l: (e: any) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(l);
  }
  removeEventListener(type: string, l: (e: any) => void) {
    this.listeners.get(type)?.delete(l);
  }
  emit(type: string, e: any) {
    for (const l of [...(this.listeners.get(type) ?? [])]) l(e);
  }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

class FakeChannel extends FakeTarget implements RtcDataChannelLike {
  readyState = 'connecting';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  peer: FakeChannel | null = null;
  constructor(readonly label: string) {
    super();
  }
  open() {
    this.readyState = 'open';
    this.emit('open', {});
  }
  send(data: string | ArrayBuffer | ArrayBufferView) {
    const peer = this.peer;
    if (!peer || this.readyState !== 'open') throw new Error('not open');
    // Like react-native-webrtc: binary arrives as an ArrayBuffer copy.
    const payload =
      typeof data === 'string'
        ? data
        : ArrayBuffer.isView(data)
          ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
          : data.slice(0);
    void tick().then(() => peer.emit('message', { data: payload }));
  }
  close() {
    this.readyState = 'closed';
  }
}

interface FakeOptions {
  /** The certificate B's transport really presents (a MITM when it differs from B's SDP). */
  presentedByB?: string;
  failConstruct?: boolean;
}

const CERT_A = Array.from({ length: 32 }, (_, i) => (i + 0x10).toString(16).toUpperCase()).join(
  ':',
);
const CERT_B = Array.from({ length: 32 }, (_, i) => (0xf0 - i).toString(16).toUpperCase()).join(
  ':',
);

function fakeWebRtc(opts: FakeOptions = {}): WebRtcModuleLike & { pcs: { closed: boolean }[] } {
  const pcs: FakePc[] = [];
  class FakePc extends FakeTarget implements RtcPeerConnectionLike {
    connectionState = 'new';
    localDescription: RtcSessionDescriptionLike | null = null;
    remoteDescription: RtcSessionDescriptionLike | null = null;
    channel: FakeChannel | null = null;
    closed = false;
    readonly cert: string;
    constructor() {
      super();
      if (opts.failConstruct) throw new Error('WebRTCModule is null');
      this.cert = pcs.length === 0 ? CERT_A : CERT_B;
      pcs.push(this);
    }
    get other(): FakePc {
      const o = pcs.find((p) => p !== this);
      if (!o) throw new Error('no peer');
      return o;
    }
    createDataChannel(label: string) {
      this.channel = new FakeChannel(label);
      return this.channel;
    }
    sdp(type: string) {
      return `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 ${this.cert}\r\na=setup:${type === 'offer' ? 'actpass' : 'active'}\r\n`;
    }
    async createOffer() {
      return { type: 'offer', sdp: this.sdp('offer') };
    }
    async createAnswer() {
      return { type: 'answer', sdp: this.sdp('answer') };
    }
    async setLocalDescription(d: RtcSessionDescriptionLike) {
      this.localDescription = d;
      void tick().then(() => {
        this.emit('icecandidate', {
          candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 9 typ host' },
        });
        this.emit('icecandidate', { candidate: null });
      });
    }
    async setRemoteDescription(d: RtcSessionDescriptionLike) {
      this.remoteDescription = d;
      if (d.type === 'answer') {
        // The offerer's channel and its remote twin open once negotiation completes.
        const mine = this.channel;
        if (!mine) throw new Error('no channel');
        const theirs = new FakeChannel(mine.label);
        mine.peer = theirs;
        theirs.peer = mine;
        this.connectionState = 'connected';
        this.other.connectionState = 'connected';
        void tick().then(() => {
          theirs.open();
          this.other.emit('datachannel', { channel: theirs });
          mine.open();
        });
      }
    }
    async addIceCandidate() {}
    async getStats() {
      const remote = this === pcs[0] ? (opts.presentedByB ?? CERT_B) : CERT_A;
      return new Map<string, Record<string, unknown>>([
        [
          'T01',
          {
            id: 'T01',
            type: 'transport',
            dtlsState: 'connected',
            localCertificateId: 'CFL',
            remoteCertificateId: 'CFR',
          },
        ],
        [
          'CFL',
          {
            id: 'CFL',
            type: 'certificate',
            fingerprint: this.cert,
            fingerprintAlgorithm: 'sha-256',
          },
        ],
        [
          'CFR',
          { id: 'CFR', type: 'certificate', fingerprint: remote, fingerprintAlgorithm: 'sha-256' },
        ],
      ]);
    }
    close() {
      this.closed = true;
      this.connectionState = 'closed';
    }
  }
  return { RTCPeerConnection: FakePc, pcs };
}

describe('runDataChannelLoopback', () => {
  it('passes every step on a working WebRTC and closes both peers', async () => {
    const rtc = fakeWebRtc();
    const seen: string[] = [];
    const report = await runDataChannelLoopback(rtc, {
      bulkBytes: 256 * 1024,
      onStep: (s) => seen.push(s.name),
    });
    expect(report.steps.filter((s) => !s.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(seen).toEqual([
      'Create two RTCPeerConnections',
      'Negotiate + open data channel "s"',
      'Text echo',
      'Binary echo, 64 KiB message',
      'Throughput, 0.25 MiB in 64 KiB messages',
      'R-RTC-2: DTLS fingerprint via getStats (both sides)',
      'Close',
    ]);
    expect(rtc.pcs.every((p) => p.closed)).toBe(true);
    expect(formatSpikeReport(report, 'G4 spike')).toMatch(/^G4 spike\n[\s\S]*RESULT: PASS$/);
  });

  it('fails the fingerprint step when the DTLS certificate is not the SDP one (MITM)', async () => {
    const mitm = CERT_A; // B's transport presents some other certificate
    const report = await runDataChannelLoopback(fakeWebRtc({ presentedByB: mitm }), {
      bulkBytes: 64 * 1024,
    });
    const fp = report.steps.find((s) => s.name.startsWith('R-RTC-2'));
    expect(fp).toMatchObject({ ok: false, detail: 'A: mismatch' });
    expect(report.ok).toBe(false);
    expect(formatSpikeReport(report, 'x')).toMatch(/RESULT: FAIL$/);
  });

  it('stops after a failed construction (the native module missing) and still closes', async () => {
    const report = await runDataChannelLoopback(fakeWebRtc({ failConstruct: true }));
    expect(report.steps.map((s) => [s.name, s.ok])).toEqual([
      ['Create two RTCPeerConnections', false],
      ['Close', true],
    ]);
    expect(report.steps[0]?.detail).toBe('WebRTCModule is null');
    expect(report.ok).toBe(false);
  });

  it('times a step out instead of hanging', async () => {
    const rtc = fakeWebRtc();
    const Base = rtc.RTCPeerConnection;
    // Negotiation that never answers.
    const stuck: WebRtcModuleLike = {
      RTCPeerConnection: class extends Base {
        override async createOffer(): Promise<RtcSessionDescriptionLike> {
          return new Promise(() => {});
        }
      },
    };
    const report = await runDataChannelLoopback(stuck, { timeoutMs: 20 });
    expect(report.steps[1]).toMatchObject({
      ok: false,
      detail: 'Negotiate + open data channel "s": no answer in 20 ms',
    });
  });
});

describe('tamperFingerprint', () => {
  it('changes every fingerprint and nothing else', () => {
    const sdp = `v=0\r\na=fingerprint:sha-256 ${CERT_A}\r\na=setup:actpass\r\n`;
    const out = tamperFingerprint(sdp);
    expect(out).not.toContain(CERT_A);
    expect(out).toContain('a=setup:actpass');
    expect(out.split('\r\n')).toHaveLength(sdp.split('\r\n').length);
  });
});
