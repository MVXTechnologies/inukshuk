/**
 * An in-memory `inukshuk-rtc` Worker for the data-layer tests (G6): the room
 * protocol of `infra/rtc/worker` (challenge, signed entry, handles, join and
 * leave, verbatim forwarding, TURN minting), checked with the same core rule
 * (`verifyAuth`). Deliveries go through the test's scheduler, so a run is the
 * same every time.
 *
 * Hostile-relay knobs: `tamper` rewrites forwarded blobs, `replay` delivers
 * every forwarded blob twice; `turn` decides what a TURN request gets.
 */
import { CHALLENGE_BYTES, verifyAuth } from '@core/group/rdv';

import type { IceServer } from '@core/group/roomProto';
import { fromB64u, toB64u } from '@core/team/bytes';
import type { TeamCrypto } from '@core/team/crypto';

import type { WebSocketLike } from '../roomClient';

interface Sock {
  ws: FakeSocket;
  roomId: string;
  chal: Uint8Array;
  handle: string | null;
}

export type TurnAnswer = 'ok' | 'off' | 'busy' | 'budget' | 'rate' | 'alone' | 'silent';

export class FakeRoomServer {
  private readonly socks = new Set<Sock>();
  private nextHandle = 1;
  /** Frames the server received (sizes and types only, as the real one could see). */
  readonly seen: string[] = [];
  /** What `{t:'turn'}` gets. */
  turn: TurnAnswer = 'ok';
  turnMints = 0;
  tamper = false;
  replay = false;
  /** Refuse new sockets (the relay is down). */
  down = false;

  constructor(
    private readonly c: TeamCrypto,
    readonly host: string,
    private readonly schedule: (fn: () => void) => void,
    private readonly nowMs: () => number,
  ) {}

  /** The WebSocket factory phones use. */
  readonly factory = (url: string): WebSocketLike => {
    const m = /^wss:\/\/([^/]+)\/v1\/r\/([A-Za-z0-9_-]{22})$/.exec(url);
    const ws = new FakeSocket(
      this.schedule,
      (data) => this.onClient(sock, data),
      () => this.onClose(sock),
    );
    const sock: Sock = {
      ws,
      roomId: m?.[2] ?? '',
      chal: this.c.randomBytes(CHALLENGE_BYTES),
      handle: null,
    };
    if (m === null || m[1] !== this.host || this.down) {
      ws.remoteClose(1006, 'refused');
      return ws;
    }
    this.socks.add(sock);
    ws.open();
    this.toClient(sock, { t: 'chal', c: toB64u(sock.chal), now: this.now() });
    return ws;
  };

  private now(): number {
    return Math.floor(this.nowMs() / 1000);
  }

  /** Authenticated sockets in a room. */
  members(roomId: string): number {
    return [...this.socks].filter((s) => s.roomId === roomId && s.handle !== null).length;
  }

  /** Every room with someone in it. */
  rooms(): string[] {
    return [...new Set([...this.socks].filter((s) => s.handle !== null).map((s) => s.roomId))];
  }

  /** Drop every socket (a relay restart). */
  dropAll(): void {
    for (const s of [...this.socks]) {
      this.socks.delete(s);
      s.ws.remoteClose(1012, 'restart');
      this.left(s);
    }
  }

  private toClient(s: Sock, frame: unknown): void {
    s.ws.deliver(JSON.stringify(frame));
  }

  private others(s: Sock): Sock[] {
    return [...this.socks].filter((o) => o !== s && o.roomId === s.roomId && o.handle !== null);
  }

  private onClient(s: Sock, data: string): void {
    let f: Record<string, unknown>;
    try {
      f = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return this.kick(s);
    }
    this.seen.push(String(f['t']));
    if (f['t'] === 'auth') {
      const ok = verifyAuth(
        this.c,
        this.host,
        s.roomId,
        s.chal,
        fromB64u(f['pub']),
        fromB64u(f['sig']),
      );
      if (!ok || s.handle !== null) return this.kick(s);
      const handle = new Uint8Array(8);
      handle[7] = this.nextHandle++;
      s.handle = toB64u(handle);
      const peers = this.others(s).map((o) => o.handle!);
      this.toClient(s, { t: 'ok', me: s.handle, peers, now: this.now() });
      for (const o of this.others(s)) this.toClient(o, { t: 'join', h: s.handle });
      return;
    }
    if (s.handle === null) return this.kick(s);
    if (f['t'] === 'm') {
      const to = f['to'];
      let b = String(f['b']);
      if (this.tamper) b = (b[0] === 'A' ? 'B' : 'A') + b.slice(1);
      for (const o of this.others(s)) {
        if (to !== '*' && o.handle !== to) continue;
        this.toClient(o, { t: 'm', from: s.handle, b });
        if (this.replay) this.toClient(o, { t: 'm', from: s.handle, b });
      }
      return;
    }
    if (f['t'] === 'turn') {
      if (this.turn === 'silent') return;
      if (this.others(s).length === 0) return this.toClient(s, { t: 'turn', e: 'alone' });
      if (this.turn !== 'ok') return this.toClient(s, { t: 'turn', e: this.turn });
      this.turnMints++;
      const ice: IceServer[] = [
        { urls: ['stun:stun.example.net:3478'] },
        {
          urls: ['turn:turn.example.net:3478?transport=udp'],
          username: `u${this.turnMints}`,
          credential: 'secret',
        },
      ];
      return this.toClient(s, { t: 'turn', ice, ttl: 900 });
    }
    this.kick(s);
  }

  private kick(s: Sock): void {
    this.socks.delete(s);
    s.ws.remoteClose(4003, 'protocol');
    this.left(s);
  }

  private onClose(s: Sock): void {
    if (!this.socks.delete(s)) return;
    this.left(s);
  }

  private left(s: Sock): void {
    if (s.handle === null) return;
    for (const o of this.others(s)) this.toClient(o, { t: 'leave', h: s.handle });
    s.handle = null;
  }
}

/** One fake socket: frames both ways through the scheduler. */
export class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(
    private readonly schedule: (fn: () => void) => void,
    private readonly toServer: (data: string) => void,
    private readonly closedByClient: () => void,
  ) {}

  open(): void {
    this.readyState = 1;
    this.schedule(() => this.onopen?.());
  }

  deliver(data: string): void {
    this.schedule(() => {
      if (this.readyState === 1) this.onmessage?.({ data });
    });
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('not open');
    this.schedule(() => this.toServer(data));
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.schedule(() => {
      this.closedByClient();
      this.onclose?.({ code, reason });
    });
  }

  remoteClose(code: number, reason: string): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.schedule(() => this.onclose?.({ code, reason }));
  }
}
