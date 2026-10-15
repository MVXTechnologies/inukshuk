import type { PathKind } from '../path';
import type { SimClock } from './clock';
import type { Rng } from './rng';

/**
 * The simulated network (design §8.1). Within one connection, frames are
 * reliable and ordered, as real carriers are (TCP, SCTP): a "lost" frame is
 * retransmitted after a timeout and holds up the frames behind it. The
 * adversity is *between* connections: different latencies reorder traffic
 * across peers and paths, a cut drops a connection with frames in flight
 * (a drop mid-frame), and relaying phones deliver the same op twice.
 */
export interface PathModel {
  latencyMs: number;
  jitterMs: number;
  /** Bandwidth, bytes per millisecond. */
  bytesPerMs: number;
  /** Chance a frame needs a retransmission (each adds `rtoMs`). */
  loss: number;
  rtoMs: number;
  maxFrameBytes: number;
}

export const PATH_MODELS: Readonly<Record<PathKind, PathModel>> = {
  nearby: {
    latencyMs: 4,
    jitterMs: 4,
    bytesPerMs: 2000,
    loss: 0.002,
    rtoMs: 200,
    maxFrameBytes: 512 * 1024,
  },
  direct: {
    latencyMs: 40,
    jitterMs: 30,
    bytesPerMs: 400,
    loss: 0.01,
    rtoMs: 300,
    maxFrameBytes: 64 * 1024,
  },
  relay: {
    latencyMs: 90,
    jitterMs: 60,
    bytesPerMs: 200,
    loss: 0.02,
    rtoMs: 400,
    maxFrameBytes: 64 * 1024,
  },
};

/** Bytes a sender may have in flight on one connection (the shallow native queue, design §4.4). */
export const INFLIGHT_BYTES = 64 * 1024;

export interface NetEndpoint {
  readonly name: string;
  onFrame(connId: string, data: Uint8Array): void;
  onWritable(connId: string): void;
  onClosed(connId: string, why: string): void;
}

export interface WireRecord {
  connId: string;
  path: PathKind;
  from: string;
  at: number;
  data: Uint8Array;
}

interface Pipe {
  nextFree: number;
  lastArrival: number;
  inflight: number;
  blocked: boolean;
}

export class SimConn {
  open = true;
  readonly pipes: Record<'ab' | 'ba', Pipe> = {
    ab: { nextFree: 0, lastArrival: 0, inflight: 0, blocked: false },
    ba: { nextFree: 0, lastArrival: 0, inflight: 0, blocked: false },
  };

  constructor(
    readonly id: string,
    readonly a: NetEndpoint,
    readonly b: NetEndpoint,
    readonly path: PathKind,
    readonly model: PathModel,
  ) {}

  peerOf(me: NetEndpoint): NetEndpoint {
    return me === this.a ? this.b : this.a;
  }

  /** Bytes `from` may still put in flight. */
  room(from: NetEndpoint): number {
    return Math.max(0, INFLIGHT_BYTES - this.pipes[from === this.a ? 'ab' : 'ba'].inflight);
  }
}

export class SimNetwork {
  readonly conns = new Map<string, SimConn>();
  /** Every frame ever sent (for plaintext scans, padding checks and the determinism digest). */
  readonly wire: WireRecord[] = [];
  private nextId = 0;

  constructor(
    readonly clock: SimClock,
    private readonly rnd: Rng,
    private readonly keepWire = true,
  ) {}

  /** A new connection; `a` dialled. Both ends learn about it from the caller. */
  connect(a: NetEndpoint, b: NetEndpoint, path: PathKind, model = PATH_MODELS[path]): SimConn {
    const conn = new SimConn(`c${this.nextId++}`, a, b, path, model);
    this.conns.set(conn.id, conn);
    return conn;
  }

  /** Send one frame; `false` when the connection is closed. Never over the in-flight budget. */
  send(conn: SimConn, from: NetEndpoint, data: Uint8Array): boolean {
    if (!conn.open) return false;
    if (data.length > conn.model.maxFrameBytes)
      throw new Error(`frame over carrier limit: ${data.length}`);
    const pipe = conn.pipes[from === conn.a ? 'ab' : 'ba'];
    const to = conn.peerOf(from);
    const now = this.clock.now;
    const m = conn.model;
    const depart = Math.max(now, pipe.nextFree);
    pipe.nextFree = depart + data.length / m.bytesPerMs;
    let arrival = pipe.nextFree + m.latencyMs + this.rnd() * m.jitterMs;
    while (this.rnd() < m.loss) arrival += m.rtoMs;
    arrival = Math.max(arrival, pipe.lastArrival);
    pipe.lastArrival = arrival;
    pipe.inflight += data.length;
    if (this.keepWire)
      this.wire.push({ connId: conn.id, path: conn.path, from: from.name, at: now, data });
    this.clock.at(arrival, () => {
      if (!conn.open) return;
      pipe.inflight -= data.length;
      to.onFrame(conn.id, data);
      if (conn.open && pipe.inflight < INFLIGHT_BYTES / 2) from.onWritable(conn.id);
    });
    return true;
  }

  /** Drop a connection with whatever is in flight (a partition, a radio loss). */
  cut(conn: SimConn, why = 'cut'): void {
    if (!conn.open) return;
    conn.open = false;
    this.conns.delete(conn.id);
    this.clock.after(0, () => conn.a.onClosed(conn.id, why));
    this.clock.after(0, () => conn.b.onClosed(conn.id, why));
  }

  /** Open connections between two endpoints. */
  between(a: NetEndpoint, b: NetEndpoint): SimConn[] {
    return [...this.conns.values()].filter(
      (c) => (c.a === a && c.b === b) || (c.a === b && c.b === a),
    );
  }
}
