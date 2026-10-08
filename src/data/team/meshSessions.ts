import type { MeshPeer, MeshTransport } from './meshTransport';

/**
 * Wires a {@link MeshTransport} to the team core's sync sessions (#589).
 *
 * The core (`src/core/team/sync.ts`) is a pure state machine:
 * `SyncSession.initiate(c, store, { now, handshakeTimeoutMs })` → `{ session, step }`
 * (the hi1 hello), `SyncSession.respond(c, store, { handshakeTimeoutMs })`, then
 * `receive(frame, now)`, `tick(now)`, `push(ops)` and `close(why)` each return
 * a `Step { send: Uint8Array[]; events }`. This host owns the plumbing:
 *
 * - one session per connection: outbound → initiator, inbound → responder;
 * - every frame of every step goes to `transport.send`; a frame refused for
 *   backpressure waits in a bounded per-peer queue until 'writable' (over
 *   the bound, the peer is dropped — a session must never lose a frame);
 * - a session that reaches `closed` is disconnected after its last frames;
 *   one with `bannedUntil` in the future is banned at the transport too, so
 *   its address cannot reconnect (the owner's anti-DDoS rule, end to end);
 * - a periodic `tick(now)` on every session: re-sync vectors when open, and
 *   the core's handshake timeout (hi1/hi2/hi3 must finish in time) before;
 * - strikes the core counts (malformed or forged ops, `chain` rejections,
 *   decrypt failures, rate) end in `bannedUntil`, which becomes a transport
 *   ban here.
 *
 * The types are structural: the core's `SyncSession` satisfies
 * {@link FrameSession} (see meshSessions.core.test.ts).
 */

export interface FrameStep<E> {
  send: Uint8Array[];
  events: E[];
}

export interface FrameSession<E> {
  readonly phase: string;
  readonly bannedUntil: number | undefined;
  receive(frame: Uint8Array, now: number): FrameStep<E>;
  tick(now?: number): FrameStep<E>;
  close(why?: string): FrameStep<E>;
}

export interface SessionFactory<E, S extends FrameSession<E>> {
  /** Outbound connection: we speak first (pass `now` as the core's `options.now`). */
  initiate(peer: MeshPeer, now: number): { session: S; step: FrameStep<E> };
  /** Inbound connection: we wait for the peer's hello. */
  respond(peer: MeshPeer, now: number): S;
}

export interface SessionHostOptions {
  now?: () => number;
  /** Period of `tick(now)` on every session. Default 10 s; 0 disables. */
  tickMs?: number;
  /** Bytes a peer may have waiting in JS behind backpressure. Default 8 MiB. */
  maxPendingBytes?: number;
}

interface Entry<S> {
  peer: MeshPeer;
  session: S;
  pending: Uint8Array[];
  pendingBytes: number;
  closing: boolean;
}

export class MeshSessionHost<E, S extends FrameSession<E>> {
  private readonly entries = new Map<string, Entry<S>>();
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly maxPendingBytes: number;

  constructor(
    private readonly transport: MeshTransport,
    private readonly factory: SessionFactory<E, S>,
    private readonly onEvent: (peerId: string, event: E, session: S) => void,
    private readonly options: SessionHostOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.maxPendingBytes = options.maxPendingBytes ?? 8 * 1024 * 1024;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.transport.subscribe((e) => {
      switch (e.type) {
        case 'connected':
          return this.onConnected(e.peer);
        case 'frame':
          return this.onFrame(e.peerId, e.data);
        case 'writable':
          return this.flush(e.peerId);
        case 'disconnected':
          if (e.peerId !== null) this.forget(e.peerId);
          return;
        default:
          return;
      }
    });
    const tickMs = this.options.tickMs ?? 10_000;
    if (tickMs > 0) this.timer = setInterval(() => this.tickAll(), tickMs);
  }

  /** Closes every session politely (their 'bye' frames go out) and detaches. */
  stop(why = 'bye'): void {
    for (const [peerId, entry] of [...this.entries]) {
      this.apply(peerId, entry, entry.session.close(why));
    }
    this.entries.clear();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Runs `fn` on every open session (e.g. `s => s.push(ops)`) and sends what it returns. */
  forEachOpen(fn: (session: S, peer: MeshPeer) => FrameStep<E>): void {
    for (const [peerId, entry] of [...this.entries]) {
      if (entry.session.phase === 'open' && !entry.closing)
        this.apply(peerId, entry, fn(entry.session, entry.peer));
    }
  }

  /** Every live connection and its session (per-peer sync status). */
  peers(): { peer: MeshPeer; session: S }[] {
    return [...this.entries.values()]
      .filter((e) => !e.closing)
      .map((e) => ({ peer: e.peer, session: e.session }));
  }

  /** Close one connection politely (a duplicate link to the same teammate). */
  close(peerId: string, why = 'duplicate'): void {
    const entry = this.entries.get(peerId);
    if (entry) this.apply(peerId, entry, entry.session.close(why));
  }

  session(peerId: string): S | undefined {
    return this.entries.get(peerId)?.session;
  }

  get size(): number {
    return this.entries.size;
  }

  private onConnected(peer: MeshPeer): void {
    if (this.entries.has(peer.peerId)) return;
    if (peer.direction === 'out') {
      const { session, step } = this.factory.initiate(peer, this.now());
      const entry = this.add(peer, session);
      this.apply(peer.peerId, entry, step);
    } else {
      this.add(peer, this.factory.respond(peer, this.now()));
    }
  }

  private add(peer: MeshPeer, session: S): Entry<S> {
    const entry: Entry<S> = { peer, session, pending: [], pendingBytes: 0, closing: false };
    this.entries.set(peer.peerId, entry);
    return entry;
  }

  private onFrame(peerId: string, data: Uint8Array): void {
    const entry = this.entries.get(peerId);
    // A frame for a session we no longer hold: drop the connection.
    if (!entry) return this.transport.disconnect(peerId);
    if (entry.closing) return;
    this.apply(peerId, entry, entry.session.receive(data, this.now()));
  }

  private apply(peerId: string, entry: Entry<S>, step: FrameStep<E>): void {
    for (const frame of step.send) this.enqueue(peerId, entry, frame);
    for (const event of step.events) {
      try {
        this.onEvent(peerId, event, entry.session);
      } catch {
        // A UI handler's failure must not break the session's plumbing.
      }
    }
    if (entry.closing) return;
    const banned = entry.session.bannedUntil;
    const now = this.now();
    if (banned !== undefined && banned > now) {
      entry.closing = true;
      this.entries.delete(peerId);
      this.transport.ban(peerId, banned - now);
    } else if (entry.session.phase === 'closed') {
      entry.closing = true;
      if (entry.pending.length === 0) this.finish(peerId);
    }
  }

  private enqueue(peerId: string, entry: Entry<S>, frame: Uint8Array): void {
    if (entry.pending.length > 0) {
      this.hold(peerId, entry, frame);
      return;
    }
    const r = this.transport.send(peerId, frame);
    if (r.ok) return;
    if (r.reason === 'backpressure') this.hold(peerId, entry, frame);
    else if (r.reason === 'too-large') this.drop(peerId);
    // 'no-peer': the connection is gone; its 'disconnected' event cleans up.
  }

  private hold(peerId: string, entry: Entry<S>, frame: Uint8Array): void {
    if (entry.pendingBytes + frame.length > this.maxPendingBytes) return this.drop(peerId);
    entry.pending.push(frame);
    entry.pendingBytes += frame.length;
  }

  private flush(peerId: string): void {
    const entry = this.entries.get(peerId);
    if (!entry) return;
    while (entry.pending.length > 0) {
      const frame = entry.pending[0];
      if (!frame) break;
      const r = this.transport.send(peerId, frame);
      if (!r.ok && r.reason === 'backpressure') return;
      entry.pending.shift();
      entry.pendingBytes -= frame.length;
      if (!r.ok) return this.drop(peerId);
    }
    if (entry.closing) this.finish(peerId);
  }

  private finish(peerId: string): void {
    this.entries.delete(peerId);
    this.transport.disconnect(peerId);
  }

  private drop(peerId: string): void {
    this.entries.delete(peerId);
    this.transport.disconnect(peerId);
  }

  private forget(peerId: string): void {
    const entry = this.entries.get(peerId);
    if (!entry) return;
    this.entries.delete(peerId);
    // Let the session record its end; its frames have nowhere to go.
    if (entry.session.phase !== 'closed') {
      const step = entry.session.close('disconnected');
      for (const event of step.events) {
        try {
          this.onEvent(peerId, event, entry.session);
        } catch {
          // See apply().
        }
      }
    }
  }

  /** Ticks every session: open ones re-sync, handshaking ones time out. */
  tickAll(): void {
    const now = this.now();
    for (const [peerId, entry] of [...this.entries]) {
      if (!entry.closing) this.apply(peerId, entry, entry.session.tick(now));
    }
  }
}
