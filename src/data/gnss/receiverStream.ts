import { base64ToBytes } from '@core/encoding/base64';
import { reportError } from '@lib/errorReporting';
import type {
  GnssBytesEvent,
  GnssErrorEvent,
  GnssLinkState,
  NativeGnssModule,
  Subscription,
} from '@lib/gnss/nativeGnss';

/**
 * Joins the native byte pipe (modules/inukshuk-gnss) to the pure stream
 * demultiplexer in @core/gnss: base64 chunks in, parsed frames out.
 *
 * Contract with the core (src/core/gnss/README.md, "Native transport"):
 * every received chunk goes, unmodified and in order, into ONE demuxer per
 * connection, which is `reset()` whenever the stream stops being one
 * continuous byte sequence:
 *  - the link leaves `connected` (drop, reconnect, disconnect);
 *  - the receiver changes;
 *  - the native buffer overflowed (`dropped > 0`: bytes are missing);
 *  - a chunk arrives corrupt (it is skipped, so the next one is not contiguous).
 *
 * Backpressure is native: ≤ 10 `onBytes` events a second, each up to 64 KiB,
 * never one per byte. While nobody listens (no stream started, a JS reload),
 * the native side keeps up to 512 KiB and delivers it when a listener
 * attaches — which is exactly what `startReceiverStream` does.
 */

/**
 * What `GnssDemuxer` (@core/gnss/stream, PR #617) provides: `push(chunk)`
 * returns the `StreamEvent`s the chunk completes, `reset()` drops a partial
 * frame. Structural, so this adapter builds before #617 merges;
 * `new GnssDemuxer()` satisfies it as is.
 */
export interface ByteDemuxer<Frame> {
  push(chunk: Uint8Array): Frame[];
  reset(): void;
}

export interface ReceiverStreamHandlers<Frame> {
  /** Frames completed by one chunk, in stream order (never called empty). */
  onFrames(frames: Frame[], deviceId: string | null): void;
  /** Every link state, starting with the current one. */
  onState?(state: GnssLinkState): void;
  onError?(error: GnssErrorEvent): void;
  /**
   * The stream stopped being continuous (the moments the demuxer is reset).
   * Stage 3 calls `FixAssembler.flush()` here, per the @core/gnss contract.
   */
  onDiscontinuity?(reason: 'link' | 'device' | 'dropped' | 'corrupt' | 'stopped'): void;
}

export interface ReceiverStreamStats {
  chunks: number;
  bytes: number;
  /** Bytes the native buffer dropped before they could be delivered. */
  droppedBytes: number;
  /** Chunks whose base64 did not decode (skipped). */
  corruptChunks: number;
  /** Demuxer resets (each one discards a partial frame, if any). */
  resets: number;
}

export interface ReceiverStream {
  readonly stats: Readonly<ReceiverStreamStats>;
  /** Unsubscribes and resets the demuxer. Idempotent. */
  stop(): void;
}

type StreamNative = Pick<NativeGnssModule, 'addListener' | 'getState'>;

export function startReceiverStream<Frame>(
  native: StreamNative,
  demuxer: ByteDemuxer<Frame>,
  handlers: ReceiverStreamHandlers<Frame>,
): ReceiverStream {
  const stats: ReceiverStreamStats = {
    chunks: 0,
    bytes: 0,
    droppedBytes: 0,
    corruptChunks: 0,
    resets: 0,
  };
  let deviceId: string | null = null;
  let connected = false;
  let stopped = false;

  const reset = (reason: 'link' | 'device' | 'dropped' | 'corrupt' | 'stopped') => {
    demuxer.reset();
    stats.resets += 1;
    guarded(handlers.onDiscontinuity, reason);
  };

  // A throwing consumer must not take the native event path down with it.
  const guarded = <A extends unknown[]>(fn: ((...a: A) => void) | undefined, ...args: A) => {
    if (!fn) return;
    try {
      fn(...args);
    } catch (error) {
      reportError(error, 'gnss-stream');
    }
  };

  const onState = (s: GnssLinkState) => {
    if (stopped) return;
    const isConnected = s.state === 'connected';
    if (s.deviceId !== null && s.deviceId !== deviceId) reset('device');
    else if (connected && !isConnected) reset('link');
    connected = isConnected;
    if (s.deviceId !== null) deviceId = s.deviceId;
    guarded(handlers.onState, s);
  };

  const onBytes = (e: GnssBytesEvent) => {
    if (stopped) return;
    const bytes = base64ToBytes(e.data);
    if (bytes === null) {
      stats.corruptChunks += 1;
      reset('corrupt');
      return;
    }
    if (e.deviceId !== null && e.deviceId !== deviceId) {
      deviceId = e.deviceId;
      reset('device');
    }
    if (e.dropped > 0) {
      stats.droppedBytes += e.dropped;
      reset('dropped');
    }
    stats.chunks += 1;
    stats.bytes += bytes.length;
    let frames: Frame[];
    try {
      frames = demuxer.push(bytes);
    } catch (error) {
      // The core's demuxer never throws on input; a bug there must not
      // wedge the stream either.
      reportError(error, 'gnss-demux');
      reset('corrupt');
      return;
    }
    if (frames.length > 0) guarded(handlers.onFrames, frames, e.deviceId ?? deviceId);
  };

  const subs: Subscription[] = [];
  // State first, so the first bytes (possibly buffered natively while no
  // one listened) are attributed to the right link.
  subs.push(native.addListener('onState', onState));
  onState(native.getState());
  if (handlers.onError) {
    const onError = handlers.onError;
    subs.push(native.addListener('onError', (e) => guarded(onError, e)));
  }
  subs.push(native.addListener('onBytes', onBytes));

  return {
    stats,
    stop() {
      if (stopped) return;
      stopped = true;
      for (const s of subs) s.remove();
      reset('stopped');
    },
  };
}
