/**
 * Joining over the internet, the joiner's side (2.7.0 G7, security review
 * §2.4.3): the invite's own room, derived from its seed (`ir`), which only
 * the joiner and the team's members (from the admin's `irdv` record) can
 * work out. In it, the joiner runs the same join session as on the LAN —
 * hello with the invite proof, admission by any member's phone, the log —
 * inside sealed room blobs.
 *
 * - The joiner always starts the session (it holds the proof), whatever the
 *   handles; members never start one in an invite room.
 * - One member at a time: the first peer in the room, then the next if that
 *   session ends without an admission (two phones admitting at once would
 *   spend two uses of a single-use invite).
 * - Rooms follow the server's UTC day once a room told its clock.
 *
 * The admission is provisional over the internet (R-INV-4): see
 * `@core/group/provisional` and `TeamSession`.
 */
import { inviteRendezvousSecret, deriveRoom, roomDays, type Room } from '@core/group/rdv';
import { decodeRoomPayload, encodeRoomPayload, ROOM_KIND } from '@core/group/roomProto';
import type { TeamCrypto } from '@core/team/crypto';
import type { SignedOp } from '@core/team/envelope';
import type { InviteToken, JoinProof } from '@core/team/invite';
import { SyncSession, type SessionEvent, type Step, type SyncStore } from '@core/team/sync';

import type { Timers } from './linkHost';
import { ROOM_SESSION_LIMITS } from './pathManager';
import { RoomClient, type RoomEvent, type WebSocketFactory } from './roomClient';

export interface InviteJoinOptions {
  c: TeamCrypto;
  host: string;
  ws: WebSocketFactory;
  timers: Timers;
  now(): number;
  token: InviteToken;
  proof: JoinProof;
  store: SyncStore;
  /** Session ticks (ms; 0: tests tick by hand). */
  tickMs?: number;
  jitterMs?: number;
  random?: () => number;
  onEvent(event: SessionEvent, session: SyncSession): void;
  /** A room is up (the team may be reachable over the internet). */
  onRoom?(): void;
  onDiag?(event: string): void;
}

interface Attempt {
  roomId: string;
  handle: string;
  session: SyncSession;
  helloSent: boolean;
}

export class InviteRoomJoin {
  private readonly rooms = new Map<string, RoomClient>();
  private attempt: Attempt | null = null;
  /** Handles tried in each room (one session each, until the room changes). */
  private readonly tried = new Set<string>();
  private offsetMs = 0;
  private interval: unknown = null;
  private stopped = false;
  private readonly ir: Uint8Array;

  constructor(private readonly o: InviteJoinOptions) {
    this.ir = inviteRendezvousSecret(o.c, o.token.teamId, o.token.seed);
  }

  /** Whether a room is admitted (the relay reached). */
  get inRoom(): boolean {
    return [...this.rooms.values()].some((r) => r.state === 'ready');
  }

  /** Whether a join session is open or opening with a member's phone. */
  get connecting(): boolean {
    return this.attempt !== null;
  }

  start(): void {
    this.refresh();
    const every = this.o.tickMs ?? 5_000;
    if (every > 0) this.interval = this.o.timers.setInterval(() => this.tick(), every);
  }

  stop(): void {
    this.stopped = true;
    if (this.interval !== null) this.o.timers.clearInterval(this.interval);
    this.interval = null;
    this.attempt?.session.close('bye');
    this.attempt = null;
    for (const r of this.rooms.values()) r.stop();
    this.rooms.clear();
  }

  /** Send this phone's own new ops to the member now (its capabilities, its name). */
  push(ops: readonly SignedOp[]): void {
    const a = this.attempt;
    if (a === null || ops.length === 0) return;
    this.handle(a, a.session.push(ops, this.o.now()));
  }

  /** Deadlines, anti-entropy and the day's rooms. */
  tick(): void {
    if (this.stopped) return;
    this.refresh();
    const a = this.attempt;
    if (a !== null) this.handle(a, a.session.tick(this.o.now()));
    this.next();
  }

  private serverSeconds(): number {
    return Math.floor((this.o.now() + this.offsetMs) / 1000);
  }

  private refresh(): void {
    if (this.stopped) return;
    const want = new Map<string, Room>();
    for (const day of roomDays(this.serverSeconds())) {
      const room = deriveRoom(this.o.c, this.ir, day);
      want.set(room.roomId, room);
    }
    for (const [id, client] of [...this.rooms]) {
      if (want.has(id)) continue;
      client.stop();
      this.rooms.delete(id);
      if (this.attempt?.roomId === id) this.endAttempt('room');
    }
    for (const [id, room] of want) {
      if (this.rooms.has(id)) continue;
      const client = new RoomClient({
        c: this.o.c,
        host: this.o.host,
        room,
        ws: this.o.ws,
        now: this.o.now,
        timers: this.o.timers,
        ...(this.o.jitterMs !== undefined ? { jitterMs: this.o.jitterMs } : {}),
        ...(this.o.random ? { random: this.o.random } : {}),
        onEvent: (e) => this.onRoom(id, client, e),
        ...(this.o.onDiag ? { onDiag: this.o.onDiag } : {}),
      });
      this.rooms.set(id, client);
      client.start();
    }
  }

  private onRoom(roomId: string, client: RoomClient, e: RoomEvent): void {
    if (this.stopped) return;
    switch (e.type) {
      case 'ready': {
        const offset = client.serverNow() - this.o.now();
        const moved = Math.abs(offset - this.offsetMs) >= 60_000;
        this.offsetMs = offset;
        this.o.onRoom?.();
        if (moved) {
          // This phone's clock named another day: follow the server's.
          this.o.timers.setTimeout(() => this.tick(), 0);
          return;
        }
        this.next();
        return;
      }
      case 'join':
        this.next();
        return;
      case 'leave':
        this.tried.delete(e.h);
        if (this.attempt?.roomId === roomId && this.attempt.handle === e.h) this.endAttempt('left');
        return;
      case 'down':
        if (this.attempt?.roomId === roomId) this.endAttempt('down');
        return;
      case 'message': {
        const a = this.attempt;
        if (a === null || a.roomId !== roomId || a.handle !== e.from) return;
        const msg = decodeRoomPayload(e.payload);
        // Only the member answers; a `hello` from it is not a join session.
        if (msg === undefined || msg.kind !== ROOM_KIND.frame) return;
        this.handle(a, a.session.receive(msg.frame, this.o.now()));
        return;
      }
      default:
        return;
    }
  }

  /** Start a join session with the next member's phone, if none is running. */
  private next(): void {
    if (this.stopped || this.attempt !== null) return;
    for (const [roomId, client] of this.rooms) {
      if (client.state !== 'ready') continue;
      for (const h of client.peers) {
        if (this.tried.has(h)) continue;
        this.tried.add(h);
        const { session, step } = SyncSession.initiate(this.o.c, this.o.store, {
          join: this.o.proof,
          now: this.o.now(),
          limits: ROOM_SESSION_LIMITS,
        });
        this.attempt = { roomId, handle: h, session, helloSent: false };
        this.o.onDiag?.('invite room: join session');
        this.handle(this.attempt, step);
        return;
      }
    }
  }

  private handle(a: Attempt, step: Step): void {
    const client = this.rooms.get(a.roomId);
    for (const frame of step.send) {
      const kind = a.helloSent ? ROOM_KIND.frame : ROOM_KIND.hello;
      a.helloSent = true;
      if (client === undefined || !client.send(a.handle, encodeRoomPayload(kind, frame))) {
        if (a.session.phase !== 'closed') a.session.close('room');
        break;
      }
    }
    for (const event of step.events) {
      this.o.onEvent(event, a.session);
      if (event.type === 'closed' && this.attempt === a) {
        this.attempt = null;
        this.o.timers.setTimeout(() => this.next(), 0);
      }
    }
  }

  private endAttempt(why: string): void {
    const a = this.attempt;
    if (a === null) return;
    this.attempt = null;
    a.session.close(why);
    this.o.onEvent({ type: 'closed', why }, a.session);
  }
}
