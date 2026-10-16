/**
 * One rendezvous room over one WebSocket (2.7.0 design §2.3, security review
 * §2.4.2, #705): the phone's side of the `inukshuk-rtc` Worker.
 *
 * - **Entry:** the server sends a fresh challenge; the phone signs it with the
 *   room's day key (`rdv.ts`), bound to the host it dialled. The server then
 *   names this socket by a random handle and lists the others.
 * - **Blobs:** everything sent to a peer is one sealed, padded room blob
 *   (`roomBlob.ts`) dated with the SERVER's clock (from `chal`/`ok`), bound to
 *   the sender's handle; stale, replayed or spliced blobs are dropped.
 * - **TURN:** credentials come only through an admitted socket with a peer in
 *   the room (R-TURN-1); one request at a time, with a deadline.
 * - **Metadata (R-META-4):** connecting and reconnecting wait a random
 *   0–30 s; a socket alone in its room closes after 10 min and comes back
 *   later. Nothing is logged; diagnostics carry kinds only.
 *
 * The room knows nothing of groups or members: the path manager runs
 * signal-only sessions over {@link RoomClient.send} and its `message` events.
 */
import type { Room } from '@core/group/rdv';
import { signAuth } from '@core/group/rdv';
import {
  openRoomBlobText,
  ReplayWindow,
  sealRoomBlobText,
  ROOM_BLOB_MAX_PAYLOAD,
} from '@core/group/roomBlob';
import {
  authFrame,
  messageFrame,
  parseServerFrame,
  ROOM_PROTOCOL_PATH,
  TURN_REQUEST,
  type IceServer,
  type TurnRefusal,
} from '@core/group/roomProto';
import { fromB64u } from '@core/team/bytes';
import type { TeamCrypto } from '@core/team/crypto';

import type { Timers } from './linkHost';

/** The slice of the WebSocket API a room uses (React Native's global one fits). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

const WS_OPEN = 1;

export type RoomEvent =
  | { type: 'ready'; me: string; peers: string[] }
  | { type: 'join'; h: string }
  | { type: 'leave'; h: string }
  | { type: 'message'; from: string; payload: Uint8Array }
  /** The socket went away (it reconnects by itself unless stopped). */
  | { type: 'down'; reason: string };

export type TurnReply =
  { ice: IceServer[]; ttlS: number } | { error: TurnRefusal | 'error' | 'timeout' | 'closed' };

/** Connect and reconnect after a random wait up to this long (R-META-4). */
export const ROOM_JITTER_MS = 30_000;
/** A socket alone in its room closes after this long (R-META-4)… */
export const ROOM_IDLE_MS = 10 * 60_000;
/** …and comes back after this long (plus jitter). */
export const ROOM_IDLE_RETRY_MS = 5 * 60_000;
/** Reconnect backoff after failures: doubling from this, capped. */
export const ROOM_BACKOFF_MS = 2_000;
export const ROOM_BACKOFF_MAX_MS = 5 * 60_000;
/** A TURN request unanswered this long fails. */
export const TURN_TIMEOUT_MS = 10_000;
/** An admitted socket must be reached within this long of opening. */
export const ROOM_AUTH_TIMEOUT_MS = 15_000;

export interface RoomClientOptions {
  c: TeamCrypto;
  /** The relay's host (signed into the auth message), e.g. `rtc.example.com`. */
  host: string;
  room: Room;
  ws: WebSocketFactory;
  now(): number;
  timers: Timers;
  /** [0, 1); the jitter's source. */
  random?: () => number;
  /** Override {@link ROOM_JITTER_MS} (tests: 0). */
  jitterMs?: number;
  onEvent(e: RoomEvent): void;
  onDiag?(event: string): void;
}

export class RoomClient {
  state: 'idle' | 'waiting' | 'connecting' | 'ready' | 'stopped' = 'idle';
  /** Our handle while admitted. */
  me: string | undefined;
  readonly peers = new Set<string>();
  /** Server clock minus ours (ms), from the last `chal`/`ok`. */
  private offsetMs = 0;
  private socket: WebSocketLike | null = null;
  private timer: unknown = null;
  private idleTimer: unknown = null;
  private failures = 0;
  private readonly replay = new ReplayWindow();
  private turnWaiters: { resolve(r: TurnReply): void; timer: unknown }[] = [];

  constructor(private readonly o: RoomClientOptions) {}

  get roomId(): string {
    return this.o.room.roomId;
  }

  get day(): number {
    return this.o.room.day;
  }

  /** The server's clock (ms), as last told. */
  serverNow(): number {
    return this.o.now() + this.offsetMs;
  }

  /** Join the room after a random wait (R-META-4). */
  start(): void {
    if (this.state !== 'idle') return;
    this.schedule(0);
  }

  /** Leave for good. */
  stop(): void {
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    this.clearTimers();
    this.hangUp('stopped');
  }

  /** Send a payload to one peer as a sealed blob; false when it can't go now. */
  send(to: string, payload: Uint8Array): boolean {
    const ws = this.socket;
    if (
      this.state !== 'ready' ||
      this.me === undefined ||
      ws === null ||
      ws.readyState !== WS_OPEN
    ) {
      return false;
    }
    if (!this.peers.has(to) || payload.length > ROOM_BLOB_MAX_PAYLOAD) return false;
    try {
      const b = sealRoomBlobText(this.o.c, this.o.room, this.me, payload, this.serverSeconds());
      ws.send(messageFrame(to, b));
      return true;
    } catch {
      return false;
    }
  }

  /** Ask the relay for TURN credentials (one request at a time). */
  requestTurn(): Promise<TurnReply> {
    const ws = this.socket;
    if (this.state !== 'ready' || ws === null || ws.readyState !== WS_OPEN) {
      return Promise.resolve({ error: 'closed' });
    }
    return new Promise<TurnReply>((resolve) => {
      const waiter = {
        resolve,
        timer: this.o.timers.setTimeout(() => {
          const i = this.turnWaiters.indexOf(waiter);
          if (i >= 0) this.turnWaiters.splice(i, 1);
          resolve({ error: 'timeout' });
        }, TURN_TIMEOUT_MS),
      };
      this.turnWaiters.push(waiter);
      if (this.turnWaiters.length === 1) {
        try {
          ws.send(TURN_REQUEST);
        } catch {
          this.failTurns('closed');
        }
      }
    });
  }

  // ── Socket ────────────────────────────────────────────────────────────────

  private serverSeconds(): number {
    return Math.floor(this.serverNow() / 1000);
  }

  private diag(event: string): void {
    this.o.onDiag?.(event);
  }

  private jitter(): number {
    const max = this.o.jitterMs ?? ROOM_JITTER_MS;
    return max <= 0 ? 0 : Math.floor((this.o.random ?? Math.random)() * max);
  }

  private schedule(baseMs: number): void {
    if (this.state === 'stopped') return;
    this.state = 'waiting';
    if (this.timer !== null) this.o.timers.clearTimeout(this.timer);
    this.timer = this.o.timers.setTimeout(() => {
      this.timer = null;
      this.connect();
    }, baseMs + this.jitter());
  }

  private connect(): void {
    if (this.state === 'stopped') return;
    this.state = 'connecting';
    let ws: WebSocketLike;
    try {
      ws = this.o.ws(`wss://${this.o.host}${ROOM_PROTOCOL_PATH}${this.o.room.roomId}`);
    } catch {
      this.lost('connect-failed');
      return;
    }
    this.socket = ws;
    ws.onmessage = (ev) => {
      if (this.socket === ws) this.onFrame(ws, ev.data);
    };
    ws.onclose = (ev) => {
      if (this.socket === ws) this.lost(`closed ${ev.code}`);
    };
    ws.onerror = () => {
      if (this.socket === ws) this.diag('room socket error');
    };
    // Not admitted in time: give up on this socket.
    this.timer = this.o.timers.setTimeout(() => {
      this.timer = null;
      if (this.socket === ws && this.state === 'connecting') this.lost('auth-timeout');
    }, ROOM_AUTH_TIMEOUT_MS);
  }

  private onFrame(ws: WebSocketLike, data: unknown): void {
    const f = parseServerFrame(data);
    if (f === undefined) return this.lost('protocol');
    switch (f.t) {
      case 'chal': {
        this.offsetMs = f.now * 1000 - this.o.now();
        try {
          const sig = signAuth(this.o.c, this.o.room, this.o.host, f.c);
          ws.send(authFrame(this.o.room.roomPub, sig));
        } catch {
          this.lost('auth');
        }
        return;
      }
      case 'ok': {
        if (this.state !== 'connecting') return;
        this.offsetMs = f.now * 1000 - this.o.now();
        this.state = 'ready';
        this.failures = 0;
        if (this.timer !== null) this.o.timers.clearTimeout(this.timer);
        this.timer = null;
        this.me = f.me;
        this.peers.clear();
        for (const h of f.peers) if (h !== f.me) this.peers.add(h);
        this.diag('room ready');
        this.idleCheck();
        this.o.onEvent({ type: 'ready', me: f.me, peers: [...this.peers] });
        return;
      }
      case 'join':
        if (this.state !== 'ready' || f.h === this.me) return;
        this.peers.add(f.h);
        this.idleCheck();
        this.o.onEvent({ type: 'join', h: f.h });
        return;
      case 'leave':
        if (this.state !== 'ready' || !this.peers.delete(f.h)) return;
        this.idleCheck();
        this.o.onEvent({ type: 'leave', h: f.h });
        return;
      case 'm': {
        if (this.state !== 'ready' || !this.peers.has(f.from)) return;
        const now = this.serverSeconds();
        const payload = openRoomBlobText(this.o.c, this.o.room, f.from, f.b, now);
        // A blob that doesn't open is the relay's doing (or a stale replay): dropped.
        if (payload === undefined) return;
        if (!this.replay.accept(fromB64u(f.b), now)) return;
        this.o.onEvent({ type: 'message', from: f.from, payload });
        return;
      }
      case 'turn': {
        const waiter = this.turnWaiters.shift();
        if (waiter === undefined) return;
        this.o.timers.clearTimeout(waiter.timer);
        waiter.resolve('e' in f ? { error: f.e } : { ice: f.ice, ttlS: f.ttl });
        const next = this.turnWaiters[0];
        if (next !== undefined) {
          try {
            ws.send(TURN_REQUEST);
          } catch {
            this.failTurns('closed');
          }
        }
        return;
      }
      default:
        return;
    }
  }

  /** Alone in the room: close after a while, come back later (R-META-4). */
  private idleCheck(): void {
    if (this.peers.size > 0 || this.state !== 'ready') {
      if (this.idleTimer !== null) this.o.timers.clearTimeout(this.idleTimer);
      this.idleTimer = null;
      return;
    }
    if (this.idleTimer !== null) return;
    this.idleTimer = this.o.timers.setTimeout(() => {
      this.idleTimer = null;
      if (this.state !== 'ready' || this.peers.size > 0) return;
      this.diag('room idle');
      this.hangUp('idle');
      this.o.onEvent({ type: 'down', reason: 'idle' });
      this.schedule(ROOM_IDLE_RETRY_MS);
    }, ROOM_IDLE_MS);
  }

  private lost(reason: string): void {
    if (this.state === 'stopped') return;
    const wasReady = this.state === 'ready';
    this.hangUp(reason);
    this.failures = Math.min(this.failures + 1, 16);
    this.diag(`room lost ${reason.slice(0, 24)}`);
    if (wasReady) this.o.onEvent({ type: 'down', reason });
    this.schedule(Math.min(ROOM_BACKOFF_MS * 2 ** (this.failures - 1), ROOM_BACKOFF_MAX_MS));
  }

  private hangUp(reason: string): void {
    const ws = this.socket;
    this.socket = null;
    this.me = undefined;
    this.peers.clear();
    if (this.idleTimer !== null) this.o.timers.clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.failTurns('closed');
    if (ws !== null) {
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close(1000, reason.slice(0, 32));
      } catch {
        // Already gone.
      }
    }
    if (this.state !== 'stopped') this.state = 'idle';
  }

  private failTurns(why: 'closed'): void {
    for (const w of this.turnWaiters.splice(0)) {
      this.o.timers.clearTimeout(w.timer);
      w.resolve({ error: why });
    }
  }

  private clearTimers(): void {
    if (this.timer !== null) this.o.timers.clearTimeout(this.timer);
    this.timer = null;
  }
}
