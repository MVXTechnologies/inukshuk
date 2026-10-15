import type { MintResult, RateLimit } from './budget';
import {
  AUTH_DEADLINE_MS,
  type Bucket,
  BYTE_BURST,
  BYTE_RATE,
  HOUR_MS,
  MAX_AUTH_FAILS,
  MSG_BURST,
  MSG_RATE,
  recent,
  ROOM_MAX_PENDING,
  take,
} from './limits';
import {
  CHALLENGE_BYTES,
  CLOSE,
  fromB64uLen,
  HANDLE_BYTES,
  isRoomId,
  MAX_FRAME_CHARS,
  parseClientFrame,
  positiveInt,
  toB64u,
  unixSeconds,
} from './protocol';
import { verifyRoomAuth } from './rdvVerify';

/**
 * One rendezvous room: a Durable Object per room id, using the WebSocket
 * Hibernation API (security review 2026-10 §2.4.2).
 *
 * It admits a socket only after an Ed25519 signature over a fresh challenge
 * by the key whose hash is the room id (R-RDV-2), then forwards opaque blobs
 * between admitted sockets by random per-socket handle (R-RDV-3). It never
 * reads a blob, never keeps one, and has no storage (R-RLY-1): all per-socket
 * state is the socket's in-memory attachment, which dies with the socket.
 * The client IP never reaches this object, only an opaque tag (an HMAC of it
 * under a secret key, computed by the Worker) used for the per-client caps.
 *
 * Limits (R-RL-2, R-RL-3): 20 frames/s (burst 60) and 128 KiB/s per socket,
 * frames ≤ one 16 KiB blob, unauthenticated sockets closed after 10 s or 3
 * failed attempts (each failure is also a strike on the client's tag), at most
 * `ROOM_MAX_SOCKETS` authenticated sockets per room and `ROOM_MAX_PER_IP` per
 * client. A socket that breaks a limit is closed, not throttled: the session
 * frames it carries must arrive whole and in order, so a dropped frame would
 * break the session anyway.
 */

/** The parts of a WebSocket the room uses (workerd's, or a test fake). */
export interface Sock {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

/** The parts of DurableObjectState the room uses (deliberately nothing persistent). */
export interface RoomState {
  acceptWebSocket(ws: Sock): void;
  getWebSockets(): Sock[];
  setWebSocketAutoResponse?(pair: unknown): void;
}

export interface BudgetStub {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export interface RoomEnv {
  RTC_ENABLED?: string;
  ROOM_MAX_SOCKETS?: string;
  ROOM_MAX_PER_IP?: string;
  TURN_PER_SOCKET_PER_HOUR?: string;
  AUTH_FAIL_LIMITER?: RateLimit;
  BUDGET: { idFromName(name: string): unknown; get(id: unknown): BudgetStub };
}

export interface RoomDeps {
  now(): number;
  randomBytes(n: number): Uint8Array;
  subtle: SubtleCrypto;
  /** A connected pair: [client end returned to the caller, server end we keep]. */
  newPair(): [unknown, Sock];
  upgrade(client: unknown): Response;
  /** Run `fn` after `ms` (the unauthenticated-socket deadline). */
  later(fn: () => void, ms: number): void;
}

/** Per-socket state, kept in the hibernation attachment (well under 2 KiB). */
interface Att {
  /** Our handle (random, 8 bytes). */
  h: string;
  /** Room id and host this socket connected to. */
  rid: string;
  host: string;
  /** Opaque client tag (HMAC of the IP, made by the Worker). */
  tag: string;
  /** Authenticated. */
  a: boolean;
  /** Closed by us (ignore late events). */
  x: boolean;
  /** Auth deadline (ms), failed attempts, current challenge (b64u, '' once used). */
  dl: number;
  f: number;
  c: string;
  /** Frame and byte buckets. */
  mb: Bucket;
  bb: Bucket;
  /** TURN mint times (ms) and usernames (to revoke on leave). */
  tt: number[];
  tu: string[];
}

export function defaultRoomDeps(): RoomDeps {
  return {
    now: () => Date.now(),
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    subtle: crypto.subtle,
    newPair: () => {
      const pair = new WebSocketPair();
      return [pair[0], pair[1] as unknown as Sock];
    },
    upgrade: (client) => new Response(null, { status: 101, webSocket: client as WebSocket }),
    later: (fn, ms) => {
      setTimeout(fn, ms);
    },
  };
}

function att(ws: Sock): Att | undefined {
  try {
    const v = ws.deserializeAttachment() as Att | null | undefined;
    return v ?? undefined;
  } catch {
    return undefined;
  }
}

function send(ws: Sock, frame: Record<string, unknown>): void {
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    // The peer is gone; its close event cleans up.
  }
}

export class Room {
  constructor(
    private readonly state: RoomState,
    private readonly env: RoomEnv,
    private readonly deps: RoomDeps = defaultRoomDeps(),
  ) {
    // `ping` → `pong` without waking the object (keepalives cost nothing).
    const Pair = (
      globalThis as { WebSocketRequestResponsePair?: new (a: string, b: string) => unknown }
    ).WebSocketRequestResponsePair;
    if (Pair !== undefined && typeof state.setWebSocketAutoResponse === 'function') {
      state.setWebSocketAutoResponse(new Pair('ping', 'pong'));
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const roomId = url.pathname.slice('/v1/r/'.length);
    if (!url.pathname.startsWith('/v1/r/') || !isRoomId(roomId)) {
      return new Response(null, { status: 404 });
    }
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response(null, { status: 426 });
    }
    const now = this.deps.now();
    this.sweep(now);
    const live = this.live();
    const pending = live.filter(([, a]) => !a.a).length;
    if (pending >= ROOM_MAX_PENDING || live.length >= this.maxSockets() + ROOM_MAX_PENDING) {
      return new Response(null, { status: 503, headers: { 'Retry-After': '30' } });
    }
    const [client, server] = this.deps.newPair();
    this.state.acceptWebSocket(server);
    const a: Att = {
      h: this.newHandle(),
      rid: roomId,
      host: request.headers.get('x-rtc-host') ?? url.host,
      tag: request.headers.get('x-rtc-tag') ?? 'unknown',
      a: false,
      x: false,
      dl: now + AUTH_DEADLINE_MS,
      f: 0,
      c: toB64u(this.deps.randomBytes(CHALLENGE_BYTES)),
      mb: { tokens: MSG_BURST, at: now },
      bb: { tokens: BYTE_BURST, at: now },
      tt: [],
      tu: [],
    };
    server.serializeAttachment(a);
    send(server, { t: 'chal', c: a.c, now: unixSeconds(now) });
    this.deps.later(() => this.sweep(this.deps.now()), AUTH_DEADLINE_MS + 100);
    return this.deps.upgrade(client);
  }

  async webSocketMessage(ws: Sock, message: string | ArrayBuffer): Promise<void> {
    const a = att(ws);
    if (a === undefined || a.x) return;
    const now = this.deps.now();
    if (this.env.RTC_ENABLED === '0') return this.kill(ws, CLOSE.disabled, 'disabled');
    if (typeof message !== 'string') return this.kill(ws, CLOSE.protocol, 'text frames only');
    if (message.length > MAX_FRAME_CHARS) return this.kill(ws, CLOSE.tooBig, 'too big');
    const mb = take(a.mb, now, 1, MSG_RATE, MSG_BURST);
    const bb = take(a.bb, now, message.length, BYTE_RATE, BYTE_BURST);
    if (mb === undefined || bb === undefined) return this.kill(ws, CLOSE.rate, 'rate');
    a.mb = mb;
    a.bb = bb;
    ws.serializeAttachment(a);
    if (!a.a && now > a.dl) return this.kill(ws, CLOSE.authTimeout, 'auth timeout');

    const frame = parseClientFrame(message);
    if (frame === undefined) return this.kill(ws, CLOSE.protocol, 'protocol');
    if (!a.a) {
      if (frame.t !== 'auth') return this.kill(ws, CLOSE.protocol, 'auth first');
      return this.auth(ws, a, frame.pub, frame.sig, now);
    }
    switch (frame.t) {
      case 'm':
        return this.forward(ws, a, frame.to, frame.b);
      case 'turn':
        return this.turn(ws, a, now);
      default:
        return this.kill(ws, CLOSE.protocol, 'protocol');
    }
  }

  async webSocketClose(ws: Sock, code: number, reason: string): Promise<void> {
    await this.gone(ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason.slice(0, 64));
    } catch {
      // Already closed.
    }
  }

  async webSocketError(ws: Sock): Promise<void> {
    await this.gone(ws);
  }

  // ── internals ─────────────────────────────────────────────────────────

  private maxSockets(): number {
    return positiveInt(this.env.ROOM_MAX_SOCKETS, 128);
  }

  /** Sockets not closed by us, with their state. */
  private live(except?: Sock): [Sock, Att][] {
    const out: [Sock, Att][] = [];
    for (const ws of this.state.getWebSockets()) {
      if (ws === except) continue;
      const a = att(ws);
      if (a !== undefined && !a.x) out.push([ws, a]);
    }
    return out;
  }

  private authed(except?: Sock): [Sock, Att][] {
    return this.live(except).filter(([, a]) => a.a);
  }

  private newHandle(): string {
    const taken = new Set(this.live().map(([, a]) => a.h));
    let h = toB64u(this.deps.randomBytes(HANDLE_BYTES));
    // 64 random bits: a repeat means a broken RNG, not bad luck. Bounded anyway.
    for (let i = 0; i < 8 && taken.has(h); i++) h = toB64u(this.deps.randomBytes(HANDLE_BYTES));
    return h;
  }

  /** Close sockets that did not authenticate in time. */
  private sweep(now: number): void {
    for (const [ws, a] of this.live()) {
      if (!a.a && now > a.dl) void this.kill(ws, CLOSE.authTimeout, 'auth timeout');
    }
  }

  private async auth(ws: Sock, a: Att, pub: string, sig: string, now: number): Promise<void> {
    const challenge = fromB64uLen(a.c, CHALLENGE_BYTES);
    // The challenge is single use: whatever happens next, this one is spent.
    a.c = '';
    ws.serializeAttachment(a);
    const ok =
      challenge !== undefined &&
      (await verifyRoomAuth(this.deps.subtle, a.host, a.rid, challenge, pub, sig));
    const cur = att(ws);
    if (cur === undefined || cur.x) return;
    if (!ok) {
      cur.f++;
      ws.serializeAttachment(cur);
      const struck = await this.strike(cur.tag);
      if (cur.f >= MAX_AUTH_FAILS || !struck) return this.kill(ws, CLOSE.authFailed, 'auth');
      cur.c = toB64u(this.deps.randomBytes(CHALLENGE_BYTES));
      ws.serializeAttachment(cur);
      send(ws, { t: 'chal', c: cur.c, now: unixSeconds(now) });
      return;
    }
    const others = this.authed(ws);
    const sameClient = others.filter(([, o]) => o.tag === cur.tag).length;
    if (
      others.length >= this.maxSockets() ||
      sameClient >= positiveInt(this.env.ROOM_MAX_PER_IP, 4)
    ) {
      return this.kill(ws, CLOSE.full, 'room full');
    }
    cur.a = true;
    ws.serializeAttachment(cur);
    send(ws, { t: 'ok', me: cur.h, peers: others.map(([, o]) => o.h), now: unixSeconds(now) });
    for (const [peer] of others) send(peer, { t: 'join', h: cur.h });
  }

  /** Charge a failed auth to the client's tag; false when it is over its strikes. */
  private async strike(tag: string): Promise<boolean> {
    const limiter = this.env.AUTH_FAIL_LIMITER;
    if (limiter === undefined) return true;
    try {
      return (await limiter.limit({ key: tag })).success;
    } catch {
      return true; // the per-socket cap of 3 still holds
    }
  }

  private forward(ws: Sock, a: Att, to: string, b: string): void {
    const frame = JSON.stringify({ t: 'm', from: a.h, b });
    for (const [peer, o] of this.authed(ws)) {
      if (to !== '*' && o.h !== to) continue;
      try {
        peer.send(frame);
      } catch {
        // Gone; its close event cleans up.
      }
      if (to !== '*') return;
    }
  }

  private async turn(ws: Sock, a: Att, now: number): Promise<void> {
    // R-TURN-1: only for an authenticated socket that has a peer to pair with.
    if (this.authed(ws).length === 0) return send(ws, { t: 'turn', e: 'alone' });
    const times = recent(a.tt, now, HOUR_MS);
    if (times.length >= positiveInt(this.env.TURN_PER_SOCKET_PER_HOUR, 6)) {
      return send(ws, { t: 'turn', e: 'rate' });
    }
    a.tt = [...times, now];
    ws.serializeAttachment(a);
    let result: MintResult;
    try {
      const stub = this.env.BUDGET.get(this.env.BUDGET.idFromName('budget'));
      const res = await stub.fetch('https://budget/mint', {
        method: 'POST',
        body: JSON.stringify({ tag: a.tag }),
      });
      result = (await res.json()) as MintResult;
    } catch {
      result = { ok: false, e: 'busy' };
    }
    const cur = att(ws);
    if (cur === undefined || cur.x) return;
    if (!result.ok) return send(ws, { t: 'turn', e: result.e });
    cur.tu = [...cur.tu, result.username].slice(-8);
    ws.serializeAttachment(cur);
    send(ws, { t: 'turn', ice: result.iceServers, ttl: result.ttl });
  }

  private async kill(ws: Sock, code: number, reason: string): Promise<void> {
    // `gone` marks the socket and tells its peers synchronously; the TURN
    // revoke it then awaits must not hold the close back.
    const cleanup = this.gone(ws);
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
    await cleanup;
  }

  /** A socket left: tell its peers, revoke its TURN credentials. Idempotent. */
  private async gone(ws: Sock): Promise<void> {
    const a = att(ws);
    if (a === undefined || a.x) return;
    a.x = true;
    try {
      ws.serializeAttachment(a);
    } catch {
      // A closed socket may refuse; the flag only guards double events.
    }
    if (a.a) for (const [peer] of this.authed(ws)) send(peer, { t: 'leave', h: a.h });
    if (a.tu.length > 0) {
      try {
        const stub = this.env.BUDGET.get(this.env.BUDGET.idFromName('budget'));
        await stub.fetch('https://budget/revoke', {
          method: 'POST',
          body: JSON.stringify({ usernames: a.tu }),
        });
      } catch {
        // Credentials expire within 15 minutes anyway.
      }
    }
  }
}
