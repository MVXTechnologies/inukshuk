import { LANE_URGENT, LANES, laneOfStored, type Lane } from '@core/group/lanes';
import {
  channelLimits,
  IN_FLIGHT_BUDGET,
  limitsForPath,
  LinkMux,
  MemberBans,
  type CarrierConn,
  type CarrierEvent,
  type Carrier,
  type ChannelRequest,
  type LinkEvent,
  type LinkOptions,
} from '@core/group/link';
import type { PathKind } from '@core/group/path';
import type { Json } from '@core/team/canonical';
import type { TeamCrypto } from '@core/team/crypto';
import type { SignedOp } from '@core/team/envelope';
import { lanDiscoveryTag } from '@core/mesh/tag';
import {
  LINK_CAP,
  RTC_CAP,
  SyncSession,
  type SessionEvent,
  type SessionOptions,
  type SyncStore,
} from '@core/team/sync';

import { MeshLink, type MeshLinkStatus } from '@data/team/meshLink';
import type { MeshTransport } from '@data/team/meshTransport';
import { describeEvent, teamDebug } from '@data/team/teamDebug';

import { MeshCarrier, type MeshConn } from './carriers/meshCarrier';

/**
 * The phone's links (2.7.0 design §2.6 and §3.3, #705): one {@link LinkMux}
 * per connection to another phone, carrying every sync group the two share
 * as channels, served by priority lanes.
 *
 * **LAN (this PR).** The phone advertises its active team's discovery tag and
 * dials the phones it finds, exactly as 2.6 does. A connection starts in 2.6
 * framing: one raw SyncSession v1 for the advertised group, which is the
 * mux's legacy channel 0. Once it is open, the dialling side offers `up` if
 * the peer's `cap` record claims `lnk`; the responder answers `upok` as its
 * last raw frame and both switch to mux framing (no native change). A 2.6
 * phone never claims `lnk`, so it never sees `up`: its link stays raw v1, a
 * legacy single-group link, for good. On a mux link the dialling side then
 * opens a channel for every other group whose log names the peer an active
 * member (the peer answers `ch-ok` only for groups it holds).
 *
 * **Internet (G6).** Other carriers join through {@link LinkHost.attachCarrier}:
 * their connections speak mux from the first frame, bound to the member id the
 * rendezvous authenticated (a connection it cannot name is refused), and they
 * outlive the LAN's `stop` (the path manager owns them).
 *
 * What stays as in 2.6: one link per pair of phones (the lower member id's
 * dial wins, then the oldest), a ban closes the connection and bans its
 * address on the LAN, a periodic tick re-syncs every channel, and `stop`
 * says bye on every session before the transport stops.
 *
 * Every session seals on dequeue (`pull`): the link takes frames lane by lane
 * while the carrier accepts them, so an SOS goes out ahead of a catch-up.
 */

/** One sync group as the link layer sees it (the team session implements it). */
export interface GroupEndpoint {
  /** The group's replica behind its write-ahead store. */
  readonly store: SyncStore;
  /** Options this group adds to its sessions on a path (live strokes on first-party paths). */
  sessionOptions(path: PathKind): Partial<SessionOptions>;
  /** A session of this group was attached to connection `connKey`. */
  attached(connKey: string, info: { direction: 'in' | 'out'; host: string }): void;
  /** One of its sessions' events (a link that ended reports `closed` for each). */
  onSessionEvent(connKey: string, event: SessionEvent, session: SyncSession): void;
  /** Decrypt a stored op's body (lane of an SOS record, which the envelope hides). */
  decode(op: SignedOp): Json | undefined;
  /**
   * A group this phone is picking up (a folder shared with one of its teams,
   * #712): the parent team's id while its own log does not yet name this
   * phone an active member, else undefined.
   */
  pickupParent?(): string | undefined;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const globalTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export interface LinkHostOptions {
  c: TeamCrypto;
  transport: MeshTransport;
  /** This phone's member id (one device key in every group). */
  me(): string;
  /** Every group this phone holds. */
  groups(): readonly string[];
  group(groupId: string): GroupEndpoint | undefined;
  now: () => number;
  /** Period of the re-sync tick (ms). Default 20 s; 0 disables (tests tick by hand). */
  tickMs?: number;
  timers?: Timers;
  /** The mesh's frame cap when the transport was configured below the default. */
  meshFrameBytes?: number;
  /** Bytes a link keeps in its carrier's queue (default {@link IN_FLIGHT_BUDGET}). */
  inFlightBudget?: number;
  /** Link state changed (peers, mesh status). */
  onChange(): void;
  /** Diagnostics: kinds and reasons, never ids or addresses. */
  onDiag?(event: string): void;
}

/** The member id another layer (the rendezvous, G6) authenticated for a connection. */
export type IdentityOf = (conn: CarrierConn) => string | undefined;

/** Capabilities a 2.7.0 link offers in its hello. */
export const LINK_HELLO_CAPS: readonly string[] = [LINK_CAP, RTC_CAP];

/**
 * While a carrier holds {@link IN_FLIGHT_BUDGET} or more and has not said
 * `writable`, look again this often (the mesh reports its queue only when
 * asked).
 */
export const DRAIN_POLL_MS = 25;

interface ChannelSession {
  session: SyncSession;
  /** Its `closed` event has been delivered to the group. */
  closed: boolean;
}

interface HostLink {
  readonly conn: CarrierConn;
  /** The mesh (LAN, stopped with it) or another carrier. */
  readonly source: 'mesh' | 'other';
  readonly carrier: Carrier | undefined;
  readonly side: 'initiator' | 'responder';
  readonly connectedAt: number;
  /** The group of the legacy channel 0 (LAN links). */
  readonly legacyGroup: string | undefined;
  mux: LinkMux;
  readonly sessions: Map<string, ChannelSession>;
  /** Groups the peer refused a channel for (not asked again on this link). */
  readonly refused: Set<string>;
  /** Frames the carrier refused for backpressure, in order. */
  readonly held: { frame: Uint8Array; lane: Lane }[];
  /** A joiner is being admitted on it (never deduplicated). */
  joining: boolean;
  ended: boolean;
  pumping: boolean;
  again: boolean;
  paceTimer: unknown;
  /** The carrier held a full budget at the last pump: poll it until it drains. */
  full: boolean;
}

/** A link as diagnostics and tests see it. */
export interface LinkSnapshot {
  connId: string;
  path: PathKind;
  side: 'initiator' | 'responder';
  framing: 'v1' | 'mux';
  state: LinkMux['state'];
  identity: string | undefined;
  /** Groups with an open session on this link. */
  groups: string[];
  /** Carrier frames handed out per lane (0 urgent … 3 bulk). */
  sentByLane: number[];
  /** When the link's carrier connection came up, and when it last heard a frame. */
  connectedAt: number;
  lastHeard: number;
}

/** A group's session on a connection (the team screen's per-peer status). */
export interface NetPeer {
  connId: string;
  direction: 'in' | 'out';
  host: string;
  session: SyncSession;
}

export class LinkHost {
  private readonly carrier: MeshCarrier;
  private readonly links = new Map<string, HostLink>();
  /** Links that ended with frames still held behind backpressure: closed once flushed. */
  private readonly draining = new Map<string, HostLink>();
  private readonly bans = new MemberBans();
  private readonly timers: Timers;
  private mesh: MeshLink | null = null;
  private unsubscribe: (() => void) | null = null;
  private interval: unknown = null;
  private group: string | null = null;
  /** Other carriers attached (internet paths): the tick runs while any is, LAN or not. */
  private attached = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly o: LinkHostOptions) {
    this.carrier = new MeshCarrier(o.transport, o.meshFrameBytes);
    this.timers = o.timers ?? globalTimers;
  }

  private get budget(): number {
    return this.o.inFlightBudget ?? IN_FLIGHT_BUDGET;
  }

  /** Internet bans by member id (R-RL-4), shared with the rendezvous (G6). */
  get memberBans(): MemberBans {
    return this.bans;
  }

  /** Listen to link changes (the path manager re-decides on each). */
  onLinks(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    this.o.onChange();
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch {
        // A listener's failure must not break the links.
      }
    }
  }

  /**
   * The re-sync tick runs while the LAN runs OR another carrier is attached:
   * an internet-only link needs its vectors and keepalives too (G6).
   */
  private syncTicking(): void {
    const want = this.mesh !== null || this.attached > 0;
    const tickMs = this.o.tickMs ?? 20_000;
    if (want && this.interval === null && tickMs > 0) {
      this.interval = this.timers.setInterval(() => this.tick(), tickMs);
    } else if (!want && this.interval !== null) {
      this.timers.clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Whether the periodic tick is running (tests). */
  get ticking(): boolean {
    return this.interval !== null;
  }

  private now(): number {
    return this.o.now();
  }

  private diag(event: string): void {
    this.o.onDiag?.(event);
  }

  // ── Running ───────────────────────────────────────────────────────────────

  /** The group whose tag the LAN advertises (the active team), while running. */
  get advertised(): string | null {
    return this.group;
  }

  get running(): boolean {
    return this.mesh !== null;
  }

  /**
   * Start the LAN for `groupId` (advertise and browse its tag, dial what is
   * found). Running for another group stops that first: one advert at a time.
   */
  async start(groupId: string): Promise<void> {
    if (this.mesh !== null && this.group === groupId) return;
    if (this.mesh !== null) await this.stop();
    this.group = groupId;
    this.unsubscribe = this.carrier.subscribe((e) => this.onCarrier(e));
    const mesh = new MeshLink(this.o.transport, {
      tag: lanDiscoveryTag(groupId, (d) => this.o.c.sha256(d)),
      advertise: true,
      onChange: () => this.o.onChange(),
      onDiag: (event) => this.diag(event),
    });
    this.mesh = mesh;
    this.syncTicking();
    await mesh.start();
    this.changed();
  }

  /** Say bye on every link, then stop the transport (backgrounded, team switched). */
  async stop(): Promise<void> {
    const mesh = this.mesh;
    if (mesh === null) return;
    this.mesh = null;
    for (const link of [...this.links.values()]) {
      if (link.source === 'mesh') this.closeLink(link, 'bye');
    }
    for (const link of [...this.draining.values()]) {
      if (link.source === 'mesh') this.forgetDrained(link);
    }
    this.syncTicking();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.group = null;
    await mesh.stop();
    this.changed();
  }

  status(): MeshLinkStatus | null {
    return this.mesh?.status() ?? null;
  }

  get manualDials(): string[] {
    return this.mesh?.manualDials ?? [];
  }

  /** Hotspot fallback: dial a typed address (retries until stopped). */
  dial(host: string, port: number): boolean {
    return this.mesh?.dial(host, port) != null;
  }

  // ── What the groups ask ───────────────────────────────────────────────────

  /** Re-sync now: every link's tick (vectors on every channel), keepalives, channel opens. */
  tick(): void {
    for (const link of [...this.links.values()]) {
      if (link.ended) continue;
      this.handle(link, link.mux.tick(this.now()));
      this.openChannels(link);
      this.pump(link);
    }
  }

  /**
   * Push ops of `groupId` on every open session of it (except the connection
   * they came from), each on its lane: an SOS overtakes what waits.
   */
  push(groupId: string, ops: readonly SignedOp[], except: string | null): void {
    if (ops.length === 0) return;
    const g = this.o.group(groupId);
    if (g === undefined) return;
    const byLane: SignedOp[][] = [[], [], [], []];
    for (const op of ops) byLane[laneOfStored(op, g.decode(op))]!.push(op);
    const now = this.now();
    for (const link of [...this.links.values()]) {
      if (link.ended || link.conn.connId === except) continue;
      const entry = link.sessions.get(groupId);
      if (entry === undefined || entry.closed || entry.session.phase !== 'open') continue;
      for (const lane of LANES) {
        const batch = byLane[lane]!;
        if (batch.length === 0) continue;
        const step = entry.session.push(batch, now, lane);
        for (const event of step.events) this.deliver(link, groupId, entry, event);
      }
      this.pump(link);
    }
  }

  /** Every live session of `groupId`, per connection. */
  peers(groupId: string): NetPeer[] {
    const out: NetPeer[] = [];
    for (const link of this.links.values()) {
      if (link.ended) continue;
      const entry = link.sessions.get(groupId);
      if (entry === undefined || entry.closed) continue;
      out.push({
        connId: link.conn.connId,
        direction: link.side === 'initiator' ? 'out' : 'in',
        host: (link.conn as Partial<MeshConn>).peer?.host ?? '',
        session: entry.session,
      });
    }
    return out;
  }

  /** Hang up on a member's phone (just removed): every link to it. */
  closeMember(member: string, why: string): void {
    for (const link of [...this.links.values()]) {
      if (!link.ended && this.identityOf(link) === member) this.closeLink(link, why);
    }
  }

  /**
   * A group left this phone: a link that is that group's raw 2.6 session
   * closes; on a mux link only its channel ends (its session says bye, the
   * peer closes the channel).
   */
  dropGroup(groupId: string, why: string): void {
    for (const link of [...this.links.values()]) {
      const entry = link.sessions.get(groupId);
      if (link.ended || entry === undefined) continue;
      if (link.mux.framing === 'v1') {
        this.closeLink(link, why);
        continue;
      }
      const step = entry.session.close(why);
      for (const event of step.events) this.deliver(link, groupId, entry, event);
      if (!entry.closed) this.deliver(link, groupId, entry, { type: 'closed', why });
      this.pump(link);
    }
  }

  /** A group was added (created, joined): carry it on the links that can. */
  groupsChanged(): void {
    for (const link of [...this.links.values()]) {
      this.openChannels(link);
      this.pump(link);
    }
  }

  /** The links, for diagnostics and tests. */
  snapshot(): LinkSnapshot[] {
    return [...this.links.values()]
      .filter((l) => !l.ended)
      .map((l) => ({
        connId: l.conn.connId,
        path: l.conn.path,
        side: l.side,
        framing: l.mux.framing,
        state: l.mux.state,
        identity: this.identityOf(l),
        groups: [...l.sessions]
          .filter(([, e]) => !e.closed && e.session.phase === 'open')
          .map(([g]) => g)
          .sort(),
        sentByLane: [...l.mux.sentByLane],
        connectedAt: l.connectedAt,
        lastHeard: l.mux.lastHeard,
      }));
  }

  /** Close one link (the path manager dropping a path it no longer needs). */
  closeConn(connId: string, why: string): void {
    const link = this.links.get(connId);
    if (link !== undefined && !link.ended) this.closeLink(link, why);
  }

  /**
   * Carry links over another carrier (G6: WebRTC direct or relayed). Its
   * connection ids must not collide with the mesh's. Returns the detach,
   * which closes that carrier's links.
   */
  attachCarrier(carrier: Carrier, identityOf: IdentityOf): () => void {
    const off = carrier.subscribe((e) => this.onCarrier(e, identityOf, carrier));
    this.attached++;
    this.syncTicking();
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      for (const link of [...this.links.values()]) {
        if (link.source === 'other' && link.carrier === carrier) this.closeLink(link, 'bye');
      }
      off();
      this.attached--;
      this.syncTicking();
    };
  }

  // ── Carrier events ────────────────────────────────────────────────────────

  private onCarrier(e: CarrierEvent, identityOf?: IdentityOf, carrier?: Carrier): void {
    switch (e.type) {
      case 'conn':
        return this.attach(e.conn, e.direction, identityOf, carrier);
      case 'frame': {
        const link = this.links.get(e.connId);
        if (link === undefined || link.ended) return;
        this.handle(link, link.mux.receive(e.data, this.now()));
        this.pump(link);
        return;
      }
      case 'writable': {
        const link = this.links.get(e.connId) ?? this.draining.get(e.connId);
        if (link !== undefined) this.pump(link);
        return;
      }
      case 'closed': {
        const drained = this.draining.get(e.connId);
        if (drained !== undefined) this.forgetDrained(drained);
        const link = this.links.get(e.connId);
        if (link === undefined) return;
        teamDebug('link', 'carrier closed', e.connId, e.reason);
        link.mux.close(e.reason, this.now());
        this.handle(link, link.mux.takeEvents());
        this.end(link, e.reason, false);
        return;
      }
      case 'state':
        this.changed();
        return;
      default:
        return;
    }
  }

  private attach(
    conn: CarrierConn,
    direction: 'in' | 'out',
    identityOf: IdentityOf | undefined,
    carrier: Carrier | undefined,
  ): void {
    if (this.links.has(conn.connId)) return;
    const side = direction === 'out' ? 'initiator' : 'responder';
    const now = this.now();
    // The LAN (2.6 framing first) only through the mesh; any other carrier is
    // mux from the first frame and must name the member at the other end.
    const legacy = identityOf === undefined;
    const identity = legacy ? undefined : identityOf(conn);
    const legacyGroup = legacy ? (this.group ?? undefined) : undefined;
    if ((legacy && legacyGroup === undefined) || (!legacy && identity === undefined)) {
      conn.close('unsupported');
      return;
    }
    const link: HostLink = {
      conn,
      source: legacy ? 'mesh' : 'other',
      carrier,
      side,
      connectedAt: now,
      legacyGroup,
      mux: undefined as unknown as LinkMux,
      sessions: new Map(),
      refused: new Set(),
      held: [],
      joining: false,
      ended: false,
      pumping: false,
      again: false,
      paceTimer: null,
      full: false,
    };
    const common: Omit<LinkOptions, 'legacy' | 'identity'> = {
      side,
      maxFrameBytes: conn.maxFrameBytes,
      limits: limitsForPath(conn.path),
      caps: LINK_HELLO_CAPS,
      // A group being picked up has no log to answer with: only its own opens carry it.
      groups: () => this.o.groups().filter((g) => this.pickupParentOf(g) === undefined),
      channelFactory: (req: ChannelRequest) => this.channelFor(link, req),
      bans: this.bans,
      now,
    };
    if (legacyGroup !== undefined) {
      // The LAN starts in 2.6 framing for the advertised group (design §2.6).
      const session = this.newSession(link, legacyGroup, side);
      if (session === undefined) {
        conn.close('no-group');
        return;
      }
      link.mux = new LinkMux(this.o.c, {
        ...common,
        legacy: { groupId: legacyGroup, channel: session },
      });
    } else {
      link.mux = new LinkMux(this.o.c, { ...common, identity: identity! });
    }
    teamDebug('link', 'attach', conn.connId, conn.path, side);
    this.links.set(conn.connId, link);
    this.handle(link, link.mux.takeEvents());
    this.pump(link);
    this.changed();
  }

  private newSession(
    link: HostLink,
    groupId: string,
    side: 'initiator' | 'responder',
  ): SyncSession | undefined {
    const g = this.o.group(groupId);
    if (g === undefined) return undefined;
    const path = link.conn.path;
    const options: SessionOptions = {
      ...g.sessionOptions(path),
      now: this.now(),
      pull: true,
      linkUpgrade: path === 'nearby',
      claims: this.claims,
      limits: channelLimits(limitsForPath(path), link.conn.maxFrameBytes),
    };
    const session =
      side === 'initiator'
        ? SyncSession.initiate(this.o.c, g.store, options).session
        : SyncSession.respond(this.o.c, g.store, options);
    link.sessions.set(groupId, { session, closed: false });
    g.attached(link.conn.connId, {
      direction: link.side === 'initiator' ? 'out' : 'in',
      host: (link.conn as Partial<MeshConn>).peer?.host ?? '',
    });
    return session;
  }

  private channelFor(link: HostLink, req: ChannelRequest): SyncSession | undefined {
    if (req.cls !== 'sync' || link.ended) return undefined;
    const prev = link.sessions.get(req.groupId);
    if (prev !== undefined && !prev.closed) return undefined;
    return this.newSession(link, req.groupId, req.side);
  }

  // ── Link events ───────────────────────────────────────────────────────────

  private handle(link: HostLink, events: readonly LinkEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case 'session': {
          const entry = link.sessions.get(e.groupId);
          if (entry !== undefined) this.deliver(link, e.groupId, entry, e.event);
          break;
        }
        case 'ready':
          this.diag('link ready');
          this.openChannels(link);
          break;
        case 'framing':
          this.diag('link upgraded');
          break;
        case 'refused':
          link.refused.add(e.groupId);
          break;
        case 'channel-closed': {
          const entry = link.sessions.get(e.groupId);
          if (entry !== undefined) {
            this.deliver(link, e.groupId, entry, { type: 'closed', why: e.why });
            link.sessions.delete(e.groupId);
          }
          // A pickup that ended without making this phone a member: not asked again here.
          if (this.pickupParentOf(e.groupId) !== undefined) link.refused.add(e.groupId);
          break;
        }
        case 'strike':
          this.diag(`strike ${e.reason}`);
          break;
        case 'closed':
          this.end(link, e.why, true);
          break;
        default:
          break;
      }
    }
  }

  /** One session event to its group, once per `closed`; dedupe on a fresh open. */
  private deliver(
    link: HostLink,
    groupId: string,
    entry: ChannelSession,
    event: SessionEvent,
  ): void {
    if (entry.closed) return;
    if (event.type === 'closed') entry.closed = true;
    teamDebug('link', 'event', link.conn.connId, describeEvent(event));
    if (event.type === 'open' && event.joining) link.joining = true;
    try {
      this.o.group(groupId)?.onSessionEvent(link.conn.connId, event, entry.session);
    } catch {
      // A group's handler failing must not break the link's plumbing.
    }
    if (event.type === 'open') {
      this.dropDuplicates(link);
      this.changed();
    }
  }

  /** The member at the other end, once a session (or the rendezvous) authenticated it. */
  private identityOf(link: HostLink): string | undefined {
    if (link.mux.identity !== undefined) return link.mux.identity;
    for (const e of link.sessions.values()) if (e.session.peer !== undefined) return e.session.peer;
    return undefined;
  }

  private isUp(link: HostLink): boolean {
    for (const e of link.sessions.values()) {
      if (!e.closed && e.session.phase === 'open') return true;
    }
    return false;
  }

  /**
   * Two phones that discover each other both dial: keep one link per pair
   * and per path. Both prefer the link the lower member id dialled, so they
   * agree; then the oldest. A nearby link and an internet link to one phone
   * are not duplicates: which paths stay up is the path manager's call
   * (design §2.5). A joiner's link is never deduplicated (closing it
   * mid-admission would only slow the join).
   */
  private dropDuplicates(link: HostLink): void {
    const other = this.identityOf(link);
    if (other === undefined || link.joining) return;
    const twins = [...this.links.values()].filter(
      (l) =>
        !l.ended &&
        !l.joining &&
        l.conn.path === link.conn.path &&
        this.identityOf(l) === other &&
        this.isUp(l),
    );
    if (twins.length < 2) return;
    const lowerIsMe = this.o.me() < other;
    const preferred = (l: HostLink) => ((l.side === 'initiator') === lowerIsMe ? 0 : 1);
    const ranked = [...twins].sort(
      (a, b) =>
        preferred(a) - preferred(b) ||
        a.connectedAt - b.connectedAt ||
        (a.conn.connId < b.conn.connId ? -1 : 1),
    );
    for (const l of ranked.slice(1)) this.closeLink(l, 'duplicate');
  }

  /**
   * A link capability (`lnk`, `rtc`) claimed by `member` in **any** group both
   * phones hold (#712: shared folders are their own groups; with no team at
   * all, a folder's own claims upgrade the LAN link and allow WebRTC).
   */
  private readonly claims = (member: string, cap: string, now: number): boolean =>
    this.o.groups().some((id) => {
      const store = this.o.group(id)?.store;
      return (
        store !== undefined &&
        store.isActiveMember(member) &&
        store.canReceive?.(member, cap, now) === true
      );
    });

  private pickupParentOf(groupId: string): string | undefined {
    try {
      return this.o.group(groupId)?.pickupParent?.();
    } catch {
      return undefined;
    }
  }

  /**
   * The dialling side of a mux link carries every other group the peer is an
   * active member of (by this phone's log); the peer refuses the ones it does
   * not hold, and those are not asked again on this link.
   *
   * **Pickups (G10, #712)** are the one exception, on either side: a phone
   * picking up a folder shared with its team has no log for it yet, so it
   * cannot know who holds it; it asks any active member of that team, and
   * never answers an open for it (its `groups` leave it out), so a peer's
   * crossing open is refused and the two never both open one group. Once its
   * log names it a member, the folder is an ordinary group again.
   */
  private openChannels(link: HostLink): void {
    if (link.ended || link.mux.state !== 'open') return;
    const peer = this.identityOf(link);
    if (peer === undefined) return;
    const me = this.o.me();
    for (const groupId of this.o.groups()) {
      if (link.refused.has(groupId) || link.mux.channelOf(groupId) !== undefined) continue;
      const g = this.o.group(groupId);
      if (g === undefined) continue;
      const parent = this.pickupParentOf(groupId);
      if (parent !== undefined) {
        const team = this.o.group(parent)?.store;
        if (team?.isActiveMember(peer) === true && team.isActiveMember(me)) link.mux.open(groupId);
        continue;
      }
      if (link.side !== 'initiator') continue;
      if (!g.store.isActiveMember(peer) || !g.store.isActiveMember(me)) continue;
      link.mux.open(groupId);
    }
  }

  /** The dialling side of a raw LAN link offers the mux once the peer claims `lnk`. */
  private maybeUpgrade(link: HostLink): void {
    if (link.ended || link.side !== 'initiator' || link.mux.framing !== 'v1') return;
    if (link.legacyGroup === undefined) return;
    const entry = link.sessions.get(link.legacyGroup);
    if (entry === undefined || entry.closed) return;
    if (entry.session.requestUpgrade(this.now())) this.diag('upgrade offered');
  }

  // ── Sending ───────────────────────────────────────────────────────────────

  /**
   * Hand frames to the carrier while it takes them. A frame refused for
   * backpressure is kept (it is sealed: the session's counter moved) and
   * goes first on `writable`. Re-entrant calls (a session event that pushes)
   * run once more at the end instead of nesting.
   */
  private pump(link: HostLink): void {
    if (link.pumping) {
      link.again = true;
      return;
    }
    link.pumping = true;
    try {
      do {
        link.again = false;
        if (!this.flushHeld(link)) break;
        if (link.ended) break;
        this.maybeUpgrade(link);
        const now = this.now();
        link.full = false;
        for (;;) {
          // Shallow native queue (design §4.4): past the budget the rest waits,
          // unsealed, in the lanes, where an SOS can still overtake it.
          if (this.inFlight(link) >= this.budget) {
            link.full = link.mux.hasPending();
            break;
          }
          const out = link.mux.nextOut(now);
          if (out === undefined) break;
          const r = link.conn.send(out.frame, out.lane);
          if (r === 'backpressure') {
            link.held.push(out);
            break;
          }
          if (r === 'closed') break;
        }
        const events = link.mux.takeEvents();
        if (events.length > 0) this.handle(link, events);
      } while (link.again);
    } finally {
      link.pumping = false;
    }
    this.pace(link);
  }

  /** Send what backpressure held; false while the carrier still refuses. */
  private flushHeld(link: HostLink): boolean {
    while (link.held.length > 0) {
      const h = link.held[0]!;
      const r = link.conn.send(h.frame, h.lane);
      if (r === 'backpressure') return false;
      link.held.shift();
      if (r === 'closed') {
        link.held.length = 0;
        break;
      }
    }
    if (link.ended && this.draining.get(link.conn.connId) === link) {
      this.forgetDrained(link);
      link.conn.close('bye');
    }
    return true;
  }

  /** What the carrier holds of this link's frames (0 when it cannot say). */
  private inFlight(link: HostLink): number {
    try {
      return link.conn.inFlight?.() ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * A link paced by its peer's limits comes back when it may send again; one
   * whose carrier holds a full budget, once it may have drained (one timer
   * per link; a `writable` event comes back sooner).
   */
  private pace(link: HostLink): void {
    if (link.ended || link.held.length > 0 || link.paceTimer !== null) return;
    const delay = link.full ? DRAIN_POLL_MS : link.mux.nextSendDelay(this.now());
    if (delay === undefined || delay <= 0) return;
    link.paceTimer = this.timers.setTimeout(() => {
      link.paceTimer = null;
      if (this.links.get(link.conn.connId) === link) this.pump(link);
    }, delay);
  }

  // ── Ending ────────────────────────────────────────────────────────────────

  /** Close a link politely: byes and `ch-close`s first, then the carrier. */
  private closeLink(link: HostLink, why: string): void {
    if (link.ended) return;
    const now = this.now();
    for (const frame of link.mux.close(why, now)) {
      if (link.held.length > 0) link.held.push({ frame, lane: LANE_URGENT });
      else if (link.conn.send(frame, LANE_URGENT) === 'backpressure') {
        link.held.push({ frame, lane: LANE_URGENT });
      }
    }
    this.handle(link, link.mux.takeEvents());
    this.end(link, why, true);
  }

  /**
   * The link is over: every session still open reports `closed`; a ban bans
   * the address (LAN) for the session's ban; the carrier connection closes
   * once what backpressure held is out.
   */
  private end(link: HostLink, why: string, hangUp: boolean): void {
    if (link.ended) return;
    link.ended = true;
    teamDebug('link', 'end', link.conn.connId, why);
    this.diag(`link closed ${why.slice(0, 40)}`);
    for (const [groupId, entry] of [...link.sessions]) {
      this.deliver(link, groupId, entry, { type: 'closed', why });
    }
    if (link.paceTimer !== null) this.timers.clearTimeout(link.paceTimer);
    link.paceTimer = null;
    if (this.links.get(link.conn.connId) === link) this.links.delete(link.conn.connId);
    link.full = false;
    if (hangUp) {
      if (why === 'banned' && link.conn.ban !== undefined) {
        link.conn.ban(this.banMs(link));
      } else if (link.held.length > 0) {
        this.draining.set(link.conn.connId, link);
      } else {
        link.conn.close(why);
      }
    }
    this.changed();
  }

  private banMs(link: HostLink): number {
    const now = this.now();
    let until = now + limitsForPath(link.conn.path).banMs;
    for (const e of link.sessions.values()) {
      const b = e.session.bannedUntil;
      if (b !== undefined && b > now) until = Math.max(until, b);
    }
    return until - now;
  }

  private forgetDrained(link: HostLink): void {
    this.draining.delete(link.conn.connId);
    link.held.length = 0;
  }
}
