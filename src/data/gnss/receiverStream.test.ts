import { bytesToBase64 } from '@core/encoding/base64';
import { GnssDemuxer, type StreamEvent } from '@core/gnss/stream';
import { reportError } from '@lib/errorReporting';
import type { GnssEvents, GnssLinkState, NativeGnssModule } from '@lib/gnss/nativeGnss';

import { fakeReceiverConnectOptions, FAKE_RECEIVER_ID } from './fakeReceiver';
import { FAKE_RECEIVER_FRAMES } from './fakeReceiverRecording';
import { startReceiverStream, type ByteDemuxer } from './receiverStream';

jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));

/** A stand-in for the native module's event emitter. */
function mockNative(initial: Partial<GnssLinkState> = {}) {
  type AnyListener = (payload: never) => void;
  const listeners = new Map<keyof GnssEvents, Set<AnyListener>>();
  const state: GnssLinkState = {
    state: 'idle',
    deviceId: null,
    transport: null,
    mtu: null,
    profile: null,
    writable: false,
    attempt: 0,
    reason: null,
    retryInMs: null,
    ...initial,
  };
  const native: Pick<NativeGnssModule, 'addListener' | 'getState'> = {
    getState: () => state,
    addListener(event, listener) {
      const set = listeners.get(event) ?? new Set<AnyListener>();
      listeners.set(event, set);
      set.add(listener);
      return { remove: () => set.delete(listener) };
    },
  };
  const emit = <K extends keyof GnssEvents>(event: K, payload: Parameters<GnssEvents[K]>[0]) => {
    for (const l of listeners.get(event) ?? []) (l as (p: typeof payload) => void)(payload);
  };
  const count = () => [...listeners.values()].reduce((n, s) => n + s.size, 0);
  return { native, emit, count };
}

const linkState = (
  s: GnssLinkState['state'],
  deviceId: string | null = 'dev-1',
): GnssLinkState => ({
  state: s,
  deviceId,
  transport: 'ble',
  mtu: 247,
  profile: 'nordic-uart',
  writable: true,
  attempt: 0,
  reason: null,
  retryInMs: null,
});

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const b64 = (s: string) => bytesToBase64(ascii(s));

/** Line framer standing in for @core/gnss's GnssDemuxer (same shape). */
class LineDemuxer implements ByteDemuxer<string> {
  private pending = '';
  resets = 0;
  push(chunk: Uint8Array): string[] {
    this.pending += String.fromCharCode(...chunk);
    const parts = this.pending.split('\n');
    this.pending = parts.pop() ?? '';
    return parts;
  }
  reset(): void {
    this.pending = '';
    this.resets += 1;
  }
}

function setup(initial?: Partial<GnssLinkState>) {
  const m = mockNative(initial);
  const demuxer = new LineDemuxer();
  const frames: string[][] = [];
  const states: GnssLinkState[] = [];
  const stream = startReceiverStream(m.native, demuxer, {
    onFrames: (f) => frames.push(f),
    onState: (s) => states.push(s),
  });
  return { ...m, demuxer, frames, states, stream };
}

const bytesEvent = (data: string, extra: { dropped?: number; deviceId?: string | null } = {}) => ({
  deviceId: extra.deviceId === undefined ? 'dev-1' : extra.deviceId,
  data,
  length: 0,
  dropped: extra.dropped ?? 0,
});

describe('startReceiverStream', () => {
  it('reports the current link state first', () => {
    const { states } = setup({ state: 'connected', deviceId: 'dev-1' });
    expect(states.map((s) => s.state)).toEqual(['connected']);
  });

  it('reassembles frames split across chunks, in order', () => {
    const { emit, frames, stream } = setup({ state: 'connected', deviceId: 'dev-1' });
    emit('onBytes', bytesEvent(b64('$GNGGA,1*00\n$GN')));
    emit('onBytes', bytesEvent(b64('RMC,2*00\n')));
    expect(frames).toEqual([['$GNGGA,1*00'], ['$GNRMC,2*00']]);
    expect(stream.stats).toMatchObject({ chunks: 2, bytes: 24, droppedBytes: 0, corruptChunks: 0 });
  });

  it('never calls onFrames for a chunk that completes nothing', () => {
    const { emit, frames } = setup({ state: 'connected', deviceId: 'dev-1' });
    emit('onBytes', bytesEvent(b64('$GNGGA,partial')));
    expect(frames).toEqual([]);
  });

  it('drops a partial frame when the native buffer lost bytes', () => {
    const { emit, frames, stream } = setup({ state: 'connected', deviceId: 'dev-1' });
    emit('onBytes', bytesEvent(b64('$GNGGA,head-of-a-line')));
    emit('onBytes', bytesEvent(b64('tail\n$GNRMC,ok\n'), { dropped: 512 }));
    // "tail" belongs to a line whose middle is gone: it must not be glued
    // onto the head (the line splitter returns it alone, unprefixed).
    expect(frames).toEqual([['tail', '$GNRMC,ok']]);
    expect(stream.stats.droppedBytes).toBe(512);
  });

  it('resets when the link leaves connected, and not on a reconnect of the same device', () => {
    const { emit, frames, demuxer } = setup({ state: 'connected', deviceId: 'dev-1' });
    const before = demuxer.resets;
    emit('onBytes', bytesEvent(b64('$GNGGA,half')));
    emit('onState', linkState('reconnecting'));
    expect(demuxer.resets).toBe(before + 1);
    emit('onState', linkState('connecting'));
    emit('onState', linkState('connected'));
    expect(demuxer.resets).toBe(before + 1);
    emit('onBytes', bytesEvent(b64('-line\n')));
    expect(frames).toEqual([['-line']]);
  });

  it('resets when bytes come from another receiver', () => {
    const { emit, frames } = setup({ state: 'connected', deviceId: 'dev-1' });
    emit('onBytes', bytesEvent(b64('$GNGGA,from-1')));
    emit('onBytes', bytesEvent(b64('$GNGGA,from-2\n'), { deviceId: 'dev-2' }));
    expect(frames).toEqual([['$GNGGA,from-2']]);
  });

  it('skips a corrupt chunk and resynchronises', () => {
    const { emit, frames, stream } = setup({ state: 'connected', deviceId: 'dev-1' });
    emit('onBytes', bytesEvent(b64('$GNGGA,a')));
    emit('onBytes', bytesEvent('not base64!'));
    emit('onBytes', bytesEvent(b64('$GNRMC,b\n')));
    expect(frames).toEqual([['$GNRMC,b']]);
    expect(stream.stats.corruptChunks).toBe(1);
  });

  it('keeps streaming when a consumer throws, and reports it', () => {
    const m = mockNative({ state: 'connected', deviceId: 'dev-1' });
    const seen: string[] = [];
    startReceiverStream(m.native, new LineDemuxer(), {
      onFrames: (f) => {
        seen.push(...f);
        throw new Error('consumer bug');
      },
    });
    m.emit('onBytes', bytesEvent(b64('a\nb\n')));
    m.emit('onBytes', bytesEvent(b64('c\n')));
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), 'gnss-stream');
  });

  it('survives a throwing demuxer', () => {
    const m = mockNative({ state: 'connected', deviceId: 'dev-1' });
    const demuxer: ByteDemuxer<string> = {
      push: jest.fn(() => {
        throw new Error('demux bug');
      }),
      reset: jest.fn(),
    };
    startReceiverStream(m.native, demuxer, { onFrames: jest.fn() });
    expect(() => m.emit('onBytes', bytesEvent(b64('x')))).not.toThrow();
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), 'gnss-demux');
  });

  it('signals every discontinuity so the fix assembler can flush', () => {
    const m = mockNative({ state: 'connected', deviceId: 'dev-1' });
    const reasons: string[] = [];
    const stream = startReceiverStream(m.native, new LineDemuxer(), {
      onFrames: jest.fn(),
      onDiscontinuity: (r) => reasons.push(r),
    });
    m.emit('onBytes', bytesEvent(b64('x'), { dropped: 3 }));
    m.emit('onBytes', bytesEvent('%%%'));
    m.emit('onState', linkState('reconnecting'));
    m.emit('onBytes', bytesEvent(b64('y'), { deviceId: 'dev-2' }));
    stream.stop();
    expect(reasons).toEqual(['device', 'dropped', 'corrupt', 'link', 'device', 'stopped']);
  });

  it('forwards errors when asked', () => {
    const m = mockNative();
    const onError = jest.fn();
    startReceiverStream(m.native, new LineDemuxer(), { onFrames: jest.fn(), onError });
    const err = { code: 'E_GNSS_LINK_LOST', message: 'gone', deviceId: 'dev-1', fatal: false };
    m.emit('onError', err);
    expect(onError).toHaveBeenCalledWith(err);
  });

  it('stop() unsubscribes everything and is idempotent', () => {
    const { emit, frames, stream, count, demuxer } = setup({
      state: 'connected',
      deviceId: 'dev-1',
    });
    expect(count()).toBe(2);
    stream.stop();
    stream.stop();
    expect(count()).toBe(0);
    emit('onBytes', bytesEvent(b64('late\n')));
    expect(frames).toEqual([]);
    expect(demuxer.resets).toBeGreaterThan(0);
  });
});

describe('simulated receiver', () => {
  it('replays the recording byte-exact through the stream path', () => {
    const opts = fakeReceiverConnectOptions();
    expect(opts).toMatchObject({
      deviceId: FAKE_RECEIVER_ID,
      transport: 'fake',
      autoReconnect: false,
    });
    expect(opts.fake?.frames).toHaveLength(FAKE_RECEIVER_FRAMES.length);
    expect(opts.fake?.loop).toBe(true);
    expect(fakeReceiverConnectOptions(false).fake?.loop).toBe(false);

    const { emit, frames } = setup({ state: 'connected', deviceId: FAKE_RECEIVER_ID });
    for (const f of opts.fake?.frames ?? []) {
      emit('onBytes', bytesEvent(f, { deviceId: FAKE_RECEIVER_ID }));
    }
    // The line splitter keeps each CR; re-joining on LF restores the bytes.
    const replayed = frames.flat().join('\n') + '\n';
    expect(replayed).toBe(FAKE_RECEIVER_FRAMES.join(''));
  });

  it('is a real DGPS → RTK fixed capture with valid NMEA checksums', () => {
    const lines = FAKE_RECEIVER_FRAMES.join('').split('\r\n').filter(Boolean);
    const quality = new Set<string>();
    for (const line of lines) {
      const m = /^\$([^*]+)\*([0-9A-F]{2})$/.exec(line);
      const body = m?.[1];
      const checksum = m?.[2];
      if (body === undefined || checksum === undefined) throw new Error(`not NMEA: ${line}`);
      let sum = 0;
      for (const c of body) sum ^= c.charCodeAt(0);
      expect(sum).toBe(parseInt(checksum, 16));
      if (/^..GGA/.test(body)) quality.add(body.split(',')[6] ?? '');
    }
    expect([...quality].sort()).toEqual(['2', '4']);
  });

  it('feeds the real @core/gnss demuxer: every recorded sentence parses', () => {
    const m = mockNative({ state: 'connected', deviceId: FAKE_RECEIVER_ID });
    const events: StreamEvent[] = [];
    const stream = startReceiverStream(m.native, new GnssDemuxer(), {
      onFrames: (f) => events.push(...f),
    });
    for (const f of fakeReceiverConnectOptions().fake?.frames ?? []) {
      m.emit('onBytes', bytesEvent(f, { deviceId: FAKE_RECEIVER_ID }));
    }
    const sentences = FAKE_RECEIVER_FRAMES.join('').split('\r\n').filter(Boolean).length;
    expect(events.filter((e) => e.kind === 'nmea')).toHaveLength(sentences);
    expect(stream.stats.corruptChunks).toBe(0);
  });
});
