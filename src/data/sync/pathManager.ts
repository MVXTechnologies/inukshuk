/**
 * Internet paths to the other phones of my groups (2.7.0 design §2.3–§2.5,
 * security review §2.4–§2.5, #705): rooms, signal-only sessions, WebRTC
 * attempts and the per-peer path decision.
 *
 * **When.** Only for groups whose `net` flag is on (an admin's switch, G7),
 * that have their own room (a folder riding a parent team has none), and
 * only while the app is in use (`setOnline`, R-META-4). Without any of that
 * this does nothing at all: no socket, no ICE.
 *
 * **Rooms (L0).** One `RoomClient` per group and day (`rdv.ts`), entered by
 * signing the server's challenge. In a room, the lower handle starts one
 * signal-only `SyncSession` per pair (`signalOnly`: authenticate and carry
 * `rtc` frames, never sync, so the relay is never a data relay). The session
 * authenticates the member; a joiner, a banned member, or anyone who is not
 * an active member gets no ICE (R-RTC-3: `canSignal`).
 *
 * **Paths.** Per member, `choosePath` (pure, `@core/group/path`) decides the
 * primary from what is up: nearby (the LAN link, from the link host),
 * direct and relay (WebRTC attempts). The lower member id dials, the other
 * answers; both close what the decision drops (one primary per peer, plus
 * the free nearby path). Direct tries first (8 s), then TURN credentials are
 * minted through the room and the relay is tried; while relayed, an ICE
 * restart toward direct every 5 min. "Always use the relay" makes every
 * attempt TURN-only on this phone (R-RTC-6).
 *
 * **Links.** A verified WebRTC connection joins the link host as another
 * carrier, bound to the member L0 authenticated (R-RTC-2: the link closes if
 * its first channel's session authenticates anyone else). Lane-0 ops go out
 * on every live link (the link host's `push`).
 *
 * **Bans (R-RL-4).** By member id, shared with the link host, never by IP.
 */
import {
  DEFAULT_PATH_POLICY,
  choosePath,
  type PathKind,
  type PathPolicy,
  type PathStatus,
} from '@core/group/path';
import type { InviteRoom } from '@core/group/invites';
import { deriveRoom, groupRooms, roomDays, type Room } from '@core/group/rdv';
import { ROOM_BLOB_MAX_PAYLOAD } from '@core/group/roomBlob';
import {
  decodeRoomPayload,
  encodeRoomPayload,
  initiatesTo,
  ROOM_KIND,
  type IceServer,
} from '@core/group/roomProto';
import type { TeamCrypto } from '@core/team/crypto';
import { RELAY_LIMITS } from '@core/team/ratelimit';
import { RTC_CAP, SyncSession, type RtcSignal, type Step, type SyncStore } from '@core/team/sync';

import { RtcCarrier, type AttemptEvent, type RtcConn } from './carriers/rtcCarrier';
import type { RtcModuleLike } from './carriers/rtcModule';
import type { LinkHost, Timers } from './linkHost';
import { RoomClient, type RoomEvent, type WebSocketFactory } from './roomClient';

/** What the path manager needs of one group. */
export interface PathGroup {
  groupId: string;
  store: SyncStore;
  /** The group's internet switch (`net`, design §6). */
  net: boolean;
  /** A group riding a parent's links has no room of its own (design §3.4). */
  parent?: string;
  /** The current epoch key (its room derives from it, rotating with it). */
  epochKey: Uint8Array | undefined;
  /** Open invites whose rooms this phone listens in, to let joiners in (G7). */
  invites?: InviteRoom[];
}

export interface PathManagerOptions {
  c: TeamCrypto;
  /** The relay's host (`inukshuk-rtc`, the owner's account). */
  host: string;
  links: LinkHost;
  groups(): PathGroup[];
  me(): string;
  ws: WebSocketFactory;
  rtc: RtcModuleLike;
  now(): number;
  timers: Timers;
  random?: () => number;
  /** Room connect jitter (R-META-4; tests: 0). */
  jitterMs?: number;
  policy?: Partial<PathPolicy>;
  /** STUN for direct attempts (public address discovery). */
  stun?: IceServer[];
  /** Period of the decision tick (ms). */
  evalMs?: number;
  /**
   * Relay-only with this member (R-INV-4): it shares a group this phone
   * joined provisionally. Other members keep direct paths.
   */
  relayOnlyWith?(member: string): boolean;
  onChange?(): void;
  onDiag?(event: string): void;
}

/**
 * A joiner's catch-up through an invite room (design exception, sync-layer
 * §3.2 "as built G7"): the log only (no position, no stroke), and it ends at
 * the hand-over — once the joiner's `rtc` claim arrived, so a direct or TURN
 * link can take over — or at these caps, whichever comes first.
 */
export const INVITE_SESSION_MS = 5 * 60_000;
export const INVITE_SESSION_MAX_BYTES = 2 * 1024 * 1024;

/** Cloudflare's public STUN (no credentials; reveals our public address to Cloudflare only). */
export const DEFAULT_STUN: IceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478'] }];
export const PATH_EVAL_MS = 2_000;
/** A signal-only session that ended is started again this long after (initiator). */
export const L0_RETRY_MS = 15_000;
/** A relay attempt that failed is not tried again for this long… */
export const RELAY_RETRY_MS = 30_000;
/** …and when the relay refused credentials (off, busy, budget), this long. */
export const TURN_REFUSED_RETRY_MS = 5 * 60_000;
/** A relay attempt (minting included) must connect within this long. */
export const RELAY_TIMEOUT_MS = 15_000;
/** The answering side adds TURN when this many offers came within {@link OFFER_WINDOW_MS}. */
export const OFFERS_FOR_TURN = 2;
export const OFFER_WINDOW_MS = 2 * 60_000;
/** A server clock offset that moved less than this keeps the rooms as they are. */
export const CLOCK_SLACK_MS = 60_000;
/** Minted credentials are reused until this long before they expire. */
const TURN_MARGIN_MS = 60_000;

/** Room sessions: the relay's budgets (R-RL-4), frames that fit one room blob. */
export const ROOM_SESSION_LIMITS = {
  ...RELAY_LIMITS,
  maxFrameBytes: ROOM_BLOB_MAX_PAYLOAD - 1,
};

interface RoomEntry {
  client: RoomClient;
  groupId: string;
  room: Room;
  /** An invite's room: joiners start sessions here, members only answer them. */
  invite: boolean;
  /** Handle → when the next session may be started to it (initiator side). */
  retryAt: Map<string, number>;
}

interface L0 {
  roomId: string;
  handle: string;
  groupId: string;
  session: SyncSession;
  /** The initiator's first frame goes as a `hello`. */
  helloSent: boolean;
  member: string | undefined;
  /** A joiner's session in an invite room (full sync, so the joiner gets the log). */
  invite: boolean;
  since: number;
  /** Bytes this phone sent on it (invite sessions are capped). */
  sent: number;
}

interface AttemptRec {
  id: string;
  /** What was asked (`relay`: TURN only), and what the connection turned out to be. */
  policy: 'direct' | 'relay';
  path: 'direct' | 'relay';
  state: 'minting' | 'connecting' | 'ready' | 'failed';
  since: number;
  conn: RtcConn | null;
}

interface PeerState {
  member: string;
  primary: PathKind | undefined;
  attempts: Map<string, AttemptRec>;
  directAttemptAt: number | undefined;
  lastDirectTryAt: number | undefined;
  relayRetryAt: number;
  offers: number[];
  turn: { ice: IceServer[]; until: number } | undefined;
  /** Signals that came while the answer waited for TURN credentials. */
  pending: RtcSignal[] | null;
}

/** One peer's paths, for the Connection sheet (G7). */
export interface PeerPathStatus {
  member: string;
  primary: PathKind | undefined;
  signalling: boolean;
  paths: Partial<Record<PathKind, PathStatus['state']>>;
}

let pendingSeq = 0;

export class PathManager {
  private readonly rooms = new Map<string, RoomEntry>();
  private readonly l0 = new Map<string, L0>();
  private readonly peers = new Map<string, PeerState>();
  private readonly rtc: RtcCarrier;
  private readonly policy: PathPolicy;
  private online = false;
  /**
   * The relay's clock minus ours (ms), once a room told it. Rooms are named
   * by the UTC day, so a phone whose clock is hours off would wait in the
   * wrong day's room: once the offset is known, rooms follow the server's day.
   */
  private clockOffsetMs: number | undefined;
  private reroom: unknown = null;
  private detach: (() => void) | null = null;
  private interval: unknown = null;
  private offLinks: (() => void) | null = null;

  constructor(private readonly o: PathManagerOptions) {
    this.policy = { ...DEFAULT_PATH_POLICY, ...o.policy };
    this.rtc = new RtcCarrier({
      module: o.rtc,
      timers: o.timers,
      onAttempt: (id, member, e) => this.onAttempt(id, member, e),
      ...(o.onDiag ? { onDiag: o.onDiag } : {}),
    });
  }

  private now(): number {
    return this.o.now();
  }

  /** The relay's time (ms): our clock corrected by the last offset a room gave. */
  serverNow(): number {
    return this.now() + (this.clockOffsetMs ?? 0);
  }

  /** A room told the server's time: keep the offset, and re-pick the rooms when it moved. */
  private learnClock(client: RoomClient): void {
    const before = this.clockOffsetMs ?? 0;
    this.clockOffsetMs = client.serverNow() - this.now();
    if (Math.abs(this.clockOffsetMs - before) < CLOCK_SLACK_MS || this.reroom !== null) return;
    this.diag('room clock offset');
    // Not from inside the room's own event: the refresh may stop that room.
    this.reroom = this.o.timers.setTimeout(() => {
      this.reroom = null;
      this.refresh();
    }, 0);
  }

  private diag(event: string): void {
    this.o.onDiag?.(event);
  }

  get alwaysRelay(): boolean {
    return this.policy.alwaysRelay;
  }

  /** In use (foreground or recording, R-META-4): rooms open for net-on groups; else all closes. */
  setOnline(on: boolean): void {
    if (this.online === on) return;
    this.online = on;
    if (on) {
      this.detach ??= this.o.links.attachCarrier(this.rtc, (conn) => (conn as RtcConn).member);
      this.offLinks ??= this.o.links.onLinks(() => this.evaluateAll());
      const every = this.o.evalMs ?? PATH_EVAL_MS;
      if (every > 0) this.interval = this.o.timers.setInterval(() => this.tick(), every);
      this.refresh();
    } else {
      if (this.interval !== null) this.o.timers.clearInterval(this.interval);
      this.interval = null;
      if (this.reroom !== null) this.o.timers.clearTimeout(this.reroom);
      this.reroom = null;
      for (const key of [...this.rooms.keys()]) this.dropRoom(key);
      this.rtc.closeAll('offline');
      this.peers.clear();
      this.offLinks?.();
      this.offLinks = null;
      this.detach?.();
      this.detach = null;
    }
    this.o.onChange?.();
  }

  /** "Always use the relay" (per phone, R-RTC-6): direct paths close and are never tried. */
  setAlwaysRelay(on: boolean): void {
    if (this.policy.alwaysRelay === on) return;
    this.policy.alwaysRelay = on;
    this.evaluateAll();
  }

  /** Relay only with this member: the user's choice, or a provisional group with it (R-INV-4). */
  private relayFor(member: string): boolean {
    return this.policy.alwaysRelay || (this.o.relayOnlyWith?.(member) ?? false);
  }

  stop(): void {
    this.setOnline(false);
  }

  /** The groups or their switches changed: open and close rooms to match. */
  refresh(): void {
    if (!this.online) return;
    const want = new Map<string, { group: PathGroup; room: Room; invite: boolean }>();
    const seconds = Math.floor(this.serverNow() / 1000);
    for (const g of this.o.groups()) {
      if (!g.net || g.parent !== undefined || g.epochKey === undefined) continue;
      try {
        for (const room of groupRooms(
          this.o.c,
          { groupId: g.groupId, epochKey: g.epochKey },
          seconds,
        )) {
          want.set(room.roomId, { group: g, room, invite: false });
        }
        for (const inv of g.invites ?? []) {
          for (const day of roomDays(seconds)) {
            const room = deriveRoom(this.o.c, inv.ir, day);
            want.set(room.roomId, { group: g, room, invite: true });
          }
        }
      } catch {
        // A group id or key of the wrong shape has no room.
      }
    }
    for (const key of [...this.rooms.keys()]) if (!want.has(key)) this.dropRoom(key);
    for (const [roomId, { group, room, invite }] of want) {
      if (this.rooms.has(roomId)) continue;
      const entry: RoomEntry = {
        groupId: group.groupId,
        room,
        invite,
        retryAt: new Map(),
        client: new RoomClient({
          c: this.o.c,
          host: this.o.host,
          room,
          ws: this.o.ws,
          now: this.o.now,
          timers: this.o.timers,
          ...(this.o.random ? { random: this.o.random } : {}),
          ...(this.o.jitterMs !== undefined ? { jitterMs: this.o.jitterMs } : {}),
          onEvent: (e) => this.onRoom(roomId, e),
          ...(this.o.onDiag ? { onDiag: this.o.onDiag } : {}),
        }),
      };
      this.rooms.set(roomId, entry);
      entry.client.start();
    }
  }

  /** Periodic: rooms (day, rotation, switches), session deadlines, retries, decisions. */
  tick(): void {
    if (!this.online) return;
    this.refresh();
    const now = this.now();
    for (const s of [...this.l0.values()]) {
      this.handleStep(s, s.session.tick(now));
    }
    for (const [roomId, entry] of this.rooms) {
      const me = entry.client.me;
      if (entry.client.state !== 'ready' || me === undefined) continue;
      for (const h of entry.client.peers) this.maybeInitiate(roomId, entry, h);
    }
    this.evaluateAll();
  }

  /** Joiners' sessions open in invite rooms now (tests, diagnostics). */
  inviteSessions(): number {
    return [...this.l0.values()].filter((s) => s.invite).length;
  }

  /** Whether the phone is in use for the internet now (`setOnline`). */
  get isOnline(): boolean {
    return this.online;
  }

  /**
   * A group's own rooms: `ready` when this phone is in one (the relay reached,
   * the pill's cloud), `failing` when reaching the relay failed, else `trying`
   * (the 0–30 s jitter, a connect in progress) or `none`.
   */
  roomState(groupId: string): 'ready' | 'failing' | 'trying' | 'none' {
    let out: 'failing' | 'trying' | 'none' = 'none';
    for (const e of this.rooms.values()) {
      if (e.invite || e.groupId !== groupId) continue;
      if (e.client.state === 'ready') return 'ready';
      out = e.client.failing ? 'failing' : out === 'failing' ? out : 'trying';
    }
    return out;
  }

  /** Per peer: the primary path and what each path is doing (the Connection sheet, G7). */
  status(): PeerPathStatus[] {
    const now = this.now();
    const members = new Set<string>([...this.peers.keys()]);
    for (const l of this.o.links.snapshot()) if (l.identity !== undefined) members.add(l.identity);
    return [...members].sort().map((member) => {
      const view = this.view(member, now);
      const paths: Partial<Record<PathKind, PathStatus['state']>> = {};
      for (const [k, s] of Object.entries(view.paths)) if (s) paths[k as PathKind] = s.state;
      return {
        member,
        primary: this.peers.get(member)?.primary,
        signalling: view.signalling,
        paths,
      };
    });
  }

  // ── Rooms and signal-only sessions ────────────────────────────────────────

  private dropRoom(roomId: string): void {
    const entry = this.rooms.get(roomId);
    if (entry === undefined) return;
    this.rooms.delete(roomId);
    entry.client.stop();
    for (const [key, s] of [...this.l0]) {
      if (s.roomId === roomId) {
        s.session.close('bye');
        this.l0.delete(key);
      }
    }
  }

  private onRoom(roomId: string, e: RoomEvent): void {
    const entry = this.rooms.get(roomId);
    if (entry === undefined) return;
    switch (e.type) {
      case 'ready':
        this.learnClock(entry.client);
        for (const h of e.peers) this.maybeInitiate(roomId, entry, h);
        break;
      case 'join':
        entry.retryAt.delete(e.h);
        this.maybeInitiate(roomId, entry, e.h);
        break;
      case 'leave':
        this.endL0(roomId, e.h, 'left');
        break;
      case 'down':
        for (const s of [...this.l0.values()])
          if (s.roomId === roomId) this.endL0(roomId, s.handle, 'down');
        break;
      case 'message':
        this.onRoomMessage(roomId, entry, e.from, e.payload);
        break;
      default:
        break;
    }
    this.o.onChange?.();
  }

  private key(roomId: string, handle: string): string {
    return `${roomId}/${handle}`;
  }

  private group(groupId: string): PathGroup | undefined {
    return this.o.groups().find((g) => g.groupId === groupId);
  }

  private sessionOptions() {
    return {
      now: this.now(),
      rtc: true,
      signalOnly: true,
      limits: ROOM_SESSION_LIMITS,
    };
  }

  private maybeInitiate(roomId: string, entry: RoomEntry, h: string): void {
    const me = entry.client.me;
    // In an invite room only joiners start sessions.
    if (entry.invite) return;
    if (me === undefined || !initiatesTo(me, h) || this.l0.has(this.key(roomId, h))) return;
    if ((entry.retryAt.get(h) ?? 0) > this.now()) return;
    const g = this.group(entry.groupId);
    if (g === undefined) return;
    const { session, step } = SyncSession.initiate(this.o.c, g.store, this.sessionOptions());
    const s: L0 = {
      roomId,
      handle: h,
      groupId: g.groupId,
      session,
      helloSent: false,
      member: undefined,
      invite: false,
      since: this.now(),
      sent: 0,
    };
    this.l0.set(this.key(roomId, h), s);
    this.handleStep(s, step);
  }

  private onRoomMessage(roomId: string, entry: RoomEntry, from: string, payload: Uint8Array): void {
    const msg = decodeRoomPayload(payload);
    if (msg === undefined) return;
    const k = this.key(roomId, from);
    let s = this.l0.get(k);
    if (msg.kind === ROOM_KIND.hello) {
      // The peer starts over (only the higher handle answers one; in an
      // invite room, whoever says hello is a joiner and is answered).
      if (entry.client.me === undefined) return;
      if (!entry.invite && initiatesTo(entry.client.me, from)) return;
      if (s !== undefined) s.session.close('restart');
      const g = this.group(entry.groupId);
      if (g === undefined) return;
      s = {
        roomId,
        handle: from,
        groupId: g.groupId,
        session: SyncSession.respond(
          this.o.c,
          g.store,
          entry.invite
            ? { now: this.now(), limits: ROOM_SESSION_LIMITS, logOnly: true }
            : this.sessionOptions(),
        ),
        helloSent: true,
        member: undefined,
        invite: entry.invite,
        since: this.now(),
        sent: 0,
      };
      this.l0.set(k, s);
    }
    if (s === undefined) return;
    this.handleStep(s, s.session.receive(msg.frame, this.now()));
  }

  private handleStep(s: L0, step: Step): void {
    const entry = this.rooms.get(s.roomId);
    for (const frame of step.send) {
      const kind = s.helloSent ? ROOM_KIND.frame : ROOM_KIND.hello;
      s.helloSent = true;
      s.sent += frame.length;
      // A frame the room can't take ends the session (the counter must stay whole).
      if (entry === undefined || !entry.client.send(s.handle, encodeRoomPayload(kind, frame))) {
        if (s.session.phase !== 'closed') s.session.close('room');
        break;
      }
    }
    for (const event of step.events) {
      switch (event.type) {
        case 'open': {
          const now = this.now();
          if (s.invite) {
            // An invite room is for joiners only: they get the log, never ICE.
            if (!event.joining) {
              this.closeL0(s, 'not-joiner');
              return;
            }
            s.member = event.peer;
            this.diag('invite room: joiner admitted');
            break;
          }
          if (event.joining || this.o.links.memberBans.isBanned(event.peer, now)) {
            // Joiners use invite rooms; a banned member gets nothing.
            this.closeL0(s, event.joining ? 'not-member' : 'banned');
            return;
          }
          s.member = event.peer;
          this.diag('room session open');
          this.evaluate(event.peer);
          break;
        }
        case 'rtc':
          if (s.member !== undefined) this.onSignal(s.member, event.signal);
          break;
        case 'strike':
          this.diag(`room strike ${event.reason}`);
          break;
        case 'closed': {
          if (event.why === 'banned' && s.member !== undefined) {
            this.o.links.memberBans.ban(
              s.member,
              s.session.bannedUntil ?? this.now() + ROOM_SESSION_LIMITS.banMs,
            );
            this.rtc.closeMember(s.member, 'banned');
          }
          this.forgetL0(s);
          break;
        }
        default:
          break;
      }
    }
    if (s.invite && s.session.phase !== 'closed') this.inviteHandover(s);
  }

  /**
   * End a joiner's invite-room session as soon as a link can take over (its
   * `rtc` claim is here), or at its byte or time cap.
   */
  private inviteHandover(s: L0): void {
    const now = this.now();
    const g = this.group(s.groupId);
    if (s.member !== undefined && g?.store.canReceive?.(s.member, RTC_CAP, now) === true) {
      this.closeL0(s, 'handover');
    } else if (s.sent > INVITE_SESSION_MAX_BYTES) {
      this.closeL0(s, 'cap');
    } else if (now - s.since > INVITE_SESSION_MS) {
      this.closeL0(s, 'done');
    }
  }

  private closeL0(s: L0, why: string): void {
    const step = s.session.close(why);
    this.handleStep(s, { send: step.send, events: [] });
    this.forgetL0(s);
  }

  private endL0(roomId: string, handle: string, why: string): void {
    const s = this.l0.get(this.key(roomId, handle));
    if (s === undefined) return;
    s.session.close(why);
    this.forgetL0(s);
  }

  private forgetL0(s: L0): void {
    const k = this.key(s.roomId, s.handle);
    if (this.l0.get(k) !== s) return;
    this.l0.delete(k);
    this.rooms.get(s.roomId)?.retryAt.set(s.handle, this.now() + L0_RETRY_MS);
    if (s.member !== undefined) this.evaluate(s.member);
  }

  /** An open signal-only session to `member` that may carry `rtc` now (R-RTC-3). */
  private signaller(member: string): L0 | undefined {
    const now = this.now();
    for (const s of this.l0.values()) {
      if (s.member === member && s.session.phase === 'open' && s.session.canSignal(now)) return s;
    }
    return undefined;
  }

  private sendSignal(member: string, signal: RtcSignal): boolean {
    const s = this.signaller(member);
    if (s === undefined) return false;
    const step = s.session.signal(signal, this.now());
    if (step.send.length === 0) return false;
    this.handleStep(s, step);
    return s.session.phase === 'open';
  }

  // ── WebRTC attempts ───────────────────────────────────────────────────────

  private peer(member: string): PeerState {
    let p = this.peers.get(member);
    if (p === undefined) {
      p = {
        member,
        primary: undefined,
        attempts: new Map(),
        directAttemptAt: undefined,
        lastDirectTryAt: undefined,
        relayRetryAt: 0,
        offers: [],
        turn: undefined,
        pending: null,
      };
      this.peers.set(member, p);
    }
    return p;
  }

  /** The lower member id dials; the other answers. */
  private dialsTo(member: string): boolean {
    return this.o.me() < member;
  }

  private onSignal(member: string, signal: RtcSignal): void {
    if (this.o.links.memberBans.isBanned(member, this.now())) return;
    const p = this.peer(member);
    if (signal.k === 'offer') {
      if (this.dialsTo(member)) return; // we dial this one; a crossing offer is ignored
      void this.answer(p, signal.sdp);
      return;
    }
    if (p.pending !== null) {
      if (p.pending.length < 64) p.pending.push(signal);
      return;
    }
    this.rtc.onSignal(member, signal);
  }

  private async answer(p: PeerState, sdp: string): Promise<void> {
    const now = this.now();
    p.offers = [...p.offers.filter((t) => now - t < OFFER_WINDOW_MS), now];
    // A newer offer replaces whatever was still negotiating.
    for (const a of p.attempts.values()) {
      if (a.state === 'connecting' || a.state === 'minting') {
        this.rtc.close(a.id, 'superseded');
        p.attempts.delete(a.id);
      }
    }
    const policy = this.relayFor(p.member) ? 'relay' : 'direct';
    const wantsTurn = policy === 'relay' || p.offers.length >= OFFERS_FOR_TURN;
    const placeholder = `pending-${++pendingSeq}`;
    p.attempts.set(placeholder, {
      id: placeholder,
      policy,
      path: policy,
      state: 'minting',
      since: now,
      conn: null,
    });
    p.pending = [];
    const turn = wantsTurn ? await this.turnFor(p) : [];
    const still = p.attempts.get(placeholder);
    p.attempts.delete(placeholder);
    const queued = p.pending ?? [];
    p.pending = null;
    if (still === undefined || !this.online) return;
    if (policy === 'relay' && turn.length === 0) {
      this.diag('relay unavailable');
      p.relayRetryAt = this.now() + TURN_REFUSED_RETRY_MS;
      return;
    }
    const id = this.rtc.answer(
      {
        member: p.member,
        policy,
        iceServers: [...(this.o.stun ?? DEFAULT_STUN), ...turn],
        timeoutMs: RELAY_TIMEOUT_MS,
        signal: (s) => this.sendSignal(p.member, s),
      },
      sdp,
    );
    if (id !== '' && !p.attempts.has(id)) {
      p.attempts.set(id, {
        id,
        policy,
        path: policy,
        state: 'connecting',
        since: this.now(),
        conn: null,
      });
    }
    for (const s of queued) this.rtc.onSignal(p.member, s);
    this.evaluate(p.member);
  }

  /** TURN credentials through a room this peer is in (cached until near expiry). */
  private async turnFor(p: PeerState): Promise<IceServer[]> {
    const now = this.now();
    if (p.turn !== undefined && p.turn.until > now) return p.turn.ice;
    const s = this.signaller(p.member);
    const client = s === undefined ? undefined : this.rooms.get(s.roomId)?.client;
    if (client === undefined) return [];
    const r = await client.requestTurn();
    if ('error' in r) {
      this.diag(`turn ${r.error}`);
      return [];
    }
    p.turn = { ice: r.ice, until: this.now() + r.ttlS * 1000 - TURN_MARGIN_MS };
    return r.ice;
  }

  private dial(p: PeerState, policy: 'direct' | 'relay'): void {
    const now = this.now();
    if (policy === 'direct') {
      p.directAttemptAt = now;
      p.lastDirectTryAt = now;
      const id = this.rtc.dial({
        member: p.member,
        policy,
        iceServers: this.o.stun ?? DEFAULT_STUN,
        timeoutMs: this.policy.directTimeoutMs,
        signal: (s) => this.sendSignal(p.member, s),
      });
      if (id !== '')
        p.attempts.set(id, {
          id,
          policy,
          path: policy,
          state: 'connecting',
          since: now,
          conn: null,
        });
      else p.directAttemptAt = undefined;
      return;
    }
    const placeholder = `pending-${++pendingSeq}`;
    p.attempts.set(placeholder, {
      id: placeholder,
      policy,
      path: policy,
      state: 'minting',
      since: now,
      conn: null,
    });
    void (async () => {
      const turn = await this.turnFor(p);
      if (!p.attempts.has(placeholder) || !this.online) return;
      p.attempts.delete(placeholder);
      if (turn.length === 0) {
        p.relayRetryAt = this.now() + TURN_REFUSED_RETRY_MS;
        this.evaluate(p.member);
        return;
      }
      const id = this.rtc.dial({
        member: p.member,
        policy: 'relay',
        iceServers: turn,
        timeoutMs: RELAY_TIMEOUT_MS,
        signal: (s) => this.sendSignal(p.member, s),
      });
      if (id !== '') {
        p.attempts.set(id, {
          id,
          policy,
          path: policy,
          state: 'connecting',
          since: this.now(),
          conn: null,
        });
      } else {
        p.relayRetryAt = this.now() + RELAY_RETRY_MS;
      }
      this.evaluate(p.member);
    })();
  }

  private onAttempt(id: string, member: string, e: AttemptEvent): void {
    const p = this.peers.get(member);
    const a = p?.attempts.get(id);
    if (p === undefined) return;
    if (a !== undefined) {
      if (e.type === 'ready') {
        a.state = 'ready';
        a.conn = e.conn;
        a.path = e.conn.path === 'relay' ? 'relay' : 'direct';
        a.since = this.now();
      } else {
        p.attempts.delete(id);
        if (a.policy === 'relay' && a.state !== 'ready')
          p.relayRetryAt = this.now() + RELAY_RETRY_MS;
      }
      if (a.policy === 'direct') {
        p.directAttemptAt = undefined;
        // Direct worked: when this path goes, try direct first again (a
        // "recent try" means a failed one, which delays direct for 5 min).
        if (e.type === 'ready') p.lastDirectTryAt = undefined;
      }
    }
    this.evaluate(member);
    this.o.onChange?.();
  }

  // ── Decisions ─────────────────────────────────────────────────────────────

  private evaluateAll(): void {
    const members = new Set<string>(this.peers.keys());
    for (const s of this.l0.values()) if (s.member !== undefined) members.add(s.member);
    for (const m of members) this.evaluate(m);
  }

  /** What `choosePath` sees of a member, from the link host and the attempts. */
  private view(member: string, now: number) {
    const paths: Partial<Record<PathKind, PathStatus>> = {};
    const links = this.o.links
      .snapshot()
      .filter((l) => l.identity === member && l.state === 'open');
    const nearby = links.filter((l) => l.path === 'nearby' && l.groups.length > 0);
    const first = nearby.sort((x, y) => x.connectedAt - y.connectedAt)[0];
    if (first !== undefined) {
      paths.nearby = { state: 'ready', since: first.connectedAt, lastHeard: first.lastHeard };
    }
    const p = this.peers.get(member);
    for (const a of p?.attempts.values() ?? []) {
      const kind: PathKind = a.state === 'ready' ? a.path : a.policy;
      let status: PathStatus;
      if (a.state === 'ready') {
        const link = links.find((l) => l.connId === a.id);
        status = { state: 'ready', since: a.since, lastHeard: link?.lastHeard ?? a.since };
      } else {
        status = { state: 'connecting', since: a.since, lastHeard: a.since };
      }
      const prev = paths[kind];
      // A ready path wins over an attempt still connecting for the same kind.
      if (prev === undefined || (prev.state !== 'ready' && status.state === 'ready'))
        paths[kind] = status;
    }
    return { paths, signalling: this.signaller(member) !== undefined };
  }

  private evaluate(member: string): void {
    if (!this.online) return;
    const now = this.now();
    const policy: PathPolicy = { ...this.policy, alwaysRelay: this.relayFor(member) };
    if (this.o.links.memberBans.isBanned(member, now)) {
      this.rtc.closeMember(member, 'banned');
      this.peers.delete(member);
      return;
    }
    const p = this.peer(member);
    const view = this.view(member, now);
    const d = choosePath(
      {
        paths: view.paths,
        primary: p.primary,
        signalling: view.signalling,
        directAttemptAt: p.directAttemptAt,
        lastDirectTryAt: p.lastDirectTryAt,
      },
      policy,
      now,
    );
    if (d.primary !== p.primary) this.diag(`path ${d.reason} ${d.primary ?? 'none'}`);
    p.primary = d.primary;
    for (const kind of d.close) {
      if (kind === 'nearby') continue;
      for (const a of [...p.attempts.values()]) {
        const k = a.state === 'ready' ? a.path : a.policy;
        if (k !== kind) continue;
        // A path still proving itself is never closed for being "connecting".
        if (a.state !== 'ready' && !(kind === 'direct' && policy.alwaysRelay)) continue;
        p.attempts.delete(a.id);
        if (a.state !== 'minting') this.rtc.close(a.id, 'not-needed');
      }
    }
    if (!this.dialsTo(member) || !view.signalling) return;
    for (const kind of d.dial) {
      if (kind === 'relay' && p.relayRetryAt > now) continue;
      if ([...p.attempts.values()].some((a) => a.policy === kind && a.state !== 'ready')) continue;
      this.dial(p, kind);
    }
    if (d.iceRestart && ![...p.attempts.values()].some((a) => a.policy === 'direct')) {
      this.diag('ice restart toward direct');
      this.dial(p, 'direct');
    }
  }
}
