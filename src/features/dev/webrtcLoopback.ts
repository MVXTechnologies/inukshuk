import {
  sdpFingerprintBinding,
  transportCertificateFingerprint,
  type StatsReport,
} from '@core/group/sdp';

/**
 * The G4 go/no-go spike (2.7.0 live sync): two RTCPeerConnections in one
 * process, a data channel between them, and the DTLS fingerprint binding of
 * R-RTC-2 read back through getStats(). Debug builds only (WebRtcSpikeScreen).
 *
 * Only the part of react-native-webrtc this uses is typed here, so the spike
 * compiles and is unit-tested (with an in-memory fake) without the package.
 */

export interface RtcEventTargetLike {
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
}

export interface RtcSessionDescriptionLike {
  readonly type: string;
  readonly sdp: string;
}

export interface RtcDataChannelLike extends RtcEventTargetLike {
  readonly label: string;
  readonly readyState: string;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(): void;
}

export interface RtcPeerConnectionLike extends RtcEventTargetLike {
  readonly connectionState: string;
  readonly localDescription: RtcSessionDescriptionLike | null;
  readonly remoteDescription: RtcSessionDescriptionLike | null;
  createDataChannel(
    label: string,
    init?: { ordered?: boolean; maxRetransmits?: number },
  ): RtcDataChannelLike;
  createOffer(): Promise<RtcSessionDescriptionLike>;
  createAnswer(): Promise<RtcSessionDescriptionLike>;
  setLocalDescription(description: RtcSessionDescriptionLike): Promise<void>;
  setRemoteDescription(description: RtcSessionDescriptionLike): Promise<void>;
  addIceCandidate(candidate: unknown): Promise<void>;
  getStats(): Promise<StatsReport>;
  close(): void;
}

/** The slice of `require('react-native-webrtc')` the spike uses. */
export interface WebRtcModuleLike {
  RTCPeerConnection: new (configuration: {
    iceServers: readonly unknown[];
  }) => RtcPeerConnectionLike;
}

export interface SpikeStep {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly ms: number;
}

export interface SpikeReport {
  readonly ok: boolean;
  readonly steps: readonly SpikeStep[];
}

export interface LoopbackOptions {
  /** Bytes pushed through the channel for the throughput step (default 4 MiB). */
  readonly bulkBytes?: number;
  /** Message size: the design's WebRTC cap (default 64 KiB). */
  readonly chunkBytes?: number;
  /** Per-step deadline (default 15 s). */
  readonly timeoutMs?: number;
  readonly now?: () => number;
  /** Progress, step by step (the screen renders it). */
  readonly onStep?: (step: SpikeStep) => void;
}

const KIB = 1024;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}: no answer in ${ms} ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** Resolves on the first `type` event of `target`. */
function once<T>(target: RtcEventTargetLike, type: string): Promise<T> {
  return new Promise<T>((resolve) => {
    const listener = (event: T) => {
      target.removeEventListener(type, listener);
      resolve(event);
    };
    target.addEventListener(type, listener);
  });
}

function pattern(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + seed) & 0xff;
  return bytes;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function asBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/** Swaps the hex of every `a=fingerprint` line, for the negative control. */
export function tamperFingerprint(sdp: string): string {
  return sdp.replace(
    /^(a=fingerprint:\S+\s+)([0-9A-Fa-f:]+)/gm,
    (_m, head: string, hex: string) => {
      const flipped = hex
        .split(':')
        .map((h) => (0xff - parseInt(h, 16)).toString(16).padStart(2, '0').toUpperCase())
        .join(':');
      return head + flipped;
    },
  );
}

/**
 * Runs the loopback and returns every step's verdict. Never throws: a failure
 * is a failed step, and both peer connections are closed at the end.
 */
export async function runDataChannelLoopback(
  rtc: WebRtcModuleLike,
  options: LoopbackOptions = {},
): Promise<SpikeReport> {
  const bulkBytes = options.bulkBytes ?? 4 * KIB * KIB;
  const chunkBytes = options.chunkBytes ?? 64 * KIB;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const now = options.now ?? Date.now;
  const steps: SpikeStep[] = [];

  const step = async (name: string, run: () => Promise<string>): Promise<boolean> => {
    const t0 = now();
    let result: SpikeStep;
    try {
      const detail = await withTimeout(run(), timeoutMs, name);
      result = { name, ok: true, detail, ms: now() - t0 };
    } catch (e) {
      result = { name, ok: false, detail: (e as Error).message, ms: now() - t0 };
    }
    steps.push(result);
    options.onStep?.(result);
    return result.ok;
  };

  // Filled in by the steps; closures assign them, so they live in an object.
  const live: {
    a?: RtcPeerConnectionLike;
    b?: RtcPeerConnectionLike;
    dcA?: RtcDataChannelLike;
    dcB?: RtcDataChannelLike;
  } = {};

  const body = async (): Promise<void> => {
    const created = await step('Create two RTCPeerConnections', async () => {
      // No STUN/TURN: in-process loopback over host candidates only.
      live.a = new rtc.RTCPeerConnection({ iceServers: [] });
      live.b = new rtc.RTCPeerConnection({ iceServers: [] });
      return 'constructed (native module loaded)';
    });
    const pa = live.a;
    const pb = live.b;
    if (!created || !pa || !pb) return;

    const connected = await step('Negotiate + open data channel "s"', async () => {
      pa.addEventListener('icecandidate', (e: { candidate?: unknown }) => {
        if (e.candidate) void pb.addIceCandidate(e.candidate);
      });
      pb.addEventListener('icecandidate', (e: { candidate?: unknown }) => {
        if (e.candidate) void pa.addIceCandidate(e.candidate);
      });
      const remoteChannel = once<{ channel: RtcDataChannelLike }>(pb, 'datachannel');
      const dcA = pa.createDataChannel('s', { ordered: true });
      live.dcA = dcA;
      const opened = once(dcA, 'open');
      const offer = await pa.createOffer();
      await pa.setLocalDescription(offer);
      await pb.setRemoteDescription(offer);
      const answer = await pb.createAnswer();
      await pb.setLocalDescription(answer);
      await pa.setRemoteDescription(answer);
      await opened;
      const dcB = (await remoteChannel).channel;
      live.dcB = dcB;
      if (dcB.readyState !== 'open') await once(dcB, 'open');
      const media = /^m=(audio|video)/m.test(offer.sdp);
      return `open; data-only offer: ${!media}`;
    });
    const chA = live.dcA;
    const chB = live.dcB;
    if (!connected || !chA || !chB) return;

    // B echoes every message back; the throughput step swaps in a counter.
    let onB: (data: unknown) => void = (data) => {
      chB.send(typeof data === 'string' ? data : (asBytes(data) ?? new Uint8Array()));
    };
    chB.addEventListener('message', (e: { data: unknown }) => onB(e.data));

    await step('Text echo', async () => {
      const echoed = once<{ data: unknown }>(chA, 'message');
      chA.send('ping:inukshuk');
      const { data } = await echoed;
      if (data !== 'ping:inukshuk') throw new Error(`echo was ${JSON.stringify(data)}`);
      return 'ping:inukshuk round-tripped';
    });

    await step(`Binary echo, ${chunkBytes / KIB} KiB message`, async () => {
      const sent = pattern(chunkBytes, 7);
      const echoed = once<{ data: unknown }>(chA, 'message');
      chA.send(sent);
      const got = asBytes((await echoed).data);
      if (!got || !sameBytes(sent, got)) {
        throw new Error(`echo differs (${got ? got.length : 'not binary'} bytes back)`);
      }
      return `${sent.length} bytes, identical`;
    });

    await step(
      `Throughput, ${bulkBytes / KIB / KIB} MiB in ${chunkBytes / KIB} KiB messages`,
      async () => {
        let received = 0;
        const done = new Promise<void>((resolve) => {
          onB = (data) => {
            received += asBytes(data)?.length ?? 0;
            if (received >= bulkBytes) resolve();
          };
        });
        chA.bufferedAmountLowThreshold = 256 * KIB;
        const chunk = pattern(chunkBytes, 3);
        const t0 = now();
        for (let sent = 0; sent < bulkBytes; sent += chunkBytes) {
          // Shallow native queue (design §4.3): wait while > 1 MiB is buffered.
          if (chA.bufferedAmount > KIB * KIB) await once(chA, 'bufferedamountlow');
          chA.send(chunk);
        }
        await done;
        const secs = Math.max(now() - t0, 1) / 1000;
        return `${Math.round(bulkBytes / KIB / secs)} KiB/s (${received} bytes)`;
      },
    );

    await step('R-RTC-2: DTLS fingerprint via getStats (both sides)', async () => {
      const [statsA, statsB] = await Promise.all([pa.getStats(), pb.getStats()]);
      const remoteSdpA = pa.remoteDescription?.sdp ?? '';
      const remoteSdpB = pb.remoteDescription?.sdp ?? '';
      const bindA = sdpFingerprintBinding(remoteSdpA, statsA);
      const bindB = sdpFingerprintBinding(remoteSdpB, statsB);
      if (!bindA.ok) throw new Error(`A: ${bindA.reason}`);
      if (!bindB.ok) throw new Error(`B: ${bindB.reason}`);
      // Cross-check: the certificate A saw as remote is the one B reports as its own.
      const localB = transportCertificateFingerprint(statsB, 'local');
      if (localB?.value !== bindA.fingerprint.value) {
        throw new Error("A's remote certificate is not B's local certificate");
      }
      // Negative control: the same stats against a tampered SDP must be refused.
      const tampered = tamperFingerprint(remoteSdpA);
      if (tampered === remoteSdpA || sdpFingerprintBinding(tampered, statsA).ok) {
        throw new Error('a tampered SDP fingerprint was accepted');
      }
      return `${bindA.fingerprint.algorithm} ${bindA.fingerprint.value.slice(0, 23)}…; tampered SDP rejected`;
    });
  };

  try {
    await body();
  } finally {
    await step('Close', async () => {
      live.dcA?.close();
      live.a?.close();
      live.b?.close();
      return 'closed';
    });
  }
  return finish();

  function finish(): SpikeReport {
    return { ok: steps.length > 0 && steps.every((s) => s.ok), steps };
  }
}

/** One line per step, then RESULT: PASS/FAIL (what a Maestro flow or a log grep reads). */
export function formatSpikeReport(report: SpikeReport, header: string): string {
  const lines = report.steps.map(
    (s) => `${s.ok ? 'ok  ' : 'FAIL'}  ${s.name} (${s.ms} ms): ${s.detail}`,
  );
  return [header, ...lines, `RESULT: ${report.ok ? 'PASS' : 'FAIL'}`].join('\n');
}
