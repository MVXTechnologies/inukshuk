import type { Json } from '../../team/canonical';
import type { DeviceKeys, TeamCrypto } from '../../team/crypto';
import type { SignedOp } from '../../team/envelope';
import { LAN_LIMITS } from '../../team/ratelimit';
import type { TeamReplica } from '../../team/replica';
import { SyncSession, LINK_CAP, RTC_CAP, type SessionEvent, type Step } from '../../team/sync';
import { isRecord } from '../../team/canonical';
import { LANE_LIVE, LANES, laneOfWrite, type Lane } from '../lanes';
import {
  channelLimits,
  limitsForPath,
  LinkMux,
  MemberBans,
  type ChannelRequest,
  type LinkEvent,
} from '../link';
import type { PathKind } from '../path';
import type { SimClock } from './clock';
import type { NetEndpoint, SimConn, SimNetwork } from './network';
import { capStore } from './store';

export type AppVersion = '2.6' | '2.7';

/** What a simulated phone needs from its world. */
export interface PhoneHost {
  readonly c: TeamCrypto;
  readonly clock: SimClock;
  readonly net: SimNetwork;
  /** Capabilities a member's phone claims (`lnk`, `rtc` for 2.7; none for 2.6). */
  claims(member: string): readonly string[];
}

/** Link capabilities a 2.7 phone offers in its `lk1` hello. */
export const LINK_HELLO_CAPS: readonly string[] = [LINK_CAP, RTC_CAP];

interface MuxLink {
  kind: 'mux';
  conn: SimConn;
  side: 'initiator' | 'responder';
  mux: LinkMux;
  /** One sync session per group on this link. */
  sessions: Map<string, SyncSession>;
  /** A pacing timer is set. */
  paceTimer?: boolean;
}

/** A 2.6 phone's connection: one raw v1 session, frames sealed at once. */
interface LegacyLink {
  kind: 'v1';
  conn: SimConn;
  groupId: string;
  session: SyncSession;
}

type Link = MuxLink | LegacyLink;

export interface PhoneStats {
  strikes: { conn: string; reason: string; version: AppVersion }[];
  closed: { conn: string; why: string }[];
  upgrades: number;
  /** Session events seen per type. */
  events: Record<string, number>;
}

/**
 * One simulated phone: its replicas (one per group), and one link per
 * connection. A 2.7 phone runs a {@link LinkMux} on every connection (raw v1
 * framing on the LAN until the `up`/`upok` upgrade, mux from the first frame
 * on the internet); a 2.6 phone runs one push-mode session per connection,
 * exactly as the shipped app does.
 */
export class SimPhone implements NetEndpoint {
  readonly groups = new Map<string, TeamReplica>();
  readonly links = new Map<string, Link>();
  readonly bans = new MemberBans();
  readonly stats: PhoneStats = { strikes: [], closed: [], upgrades: 0, events: {} };
  /** The group the phone advertises on the LAN (its active team). */
  activeGroup: string | undefined;
  /** While true, nothing leaves this phone (frames wait in the links' lanes). */
  hold = false;

  constructor(
    private readonly host: PhoneHost,
    readonly name: string,
    readonly keys: DeviceKeys,
    readonly id: string,
    readonly version: AppVersion,
  ) {}

  private get now(): number {
    return this.host.clock.now;
  }

  join(groupId: string, replica: TeamReplica): void {
    this.groups.set(groupId, replica);
    this.activeGroup ??= groupId;
  }

  // ── Connections ───────────────────────────────────────────────────────────

  /** A new connection (`initiator`: we dialled). */
  attach(conn: SimConn, side: 'initiator' | 'responder', peer: SimPhone): void {
    if (this.version === '2.6' || peer.version === '2.6') {
      if (conn.path !== 'nearby') throw new Error('2.6 phones only connect nearby');
    }
    if (this.version === '2.6') return this.attachLegacy(conn, side);
    const path = conn.path;
    const link: MuxLink = {
      kind: 'mux',
      conn,
      side,
      sessions: new Map(),
      mux: undefined as unknown as LinkMux,
    };
    const common = {
      side,
      maxFrameBytes: conn.model.maxFrameBytes,
      limits: limitsForPath(path),
      caps: LINK_HELLO_CAPS,
      groups: () => [...this.groups.keys()],
      channelFactory: (req: ChannelRequest) => this.channelFor(link, path, req),
      bans: this.bans,
      now: this.now,
    };
    if (path === 'nearby') {
      // The LAN starts in 2.6 framing for the advertised group (design §2.6).
      const groupId = this.activeGroup!;
      const session = this.newSession(groupId, path, side, conn.model.maxFrameBytes);
      if (session === undefined) return;
      link.sessions.set(groupId, session);
      link.mux = new LinkMux(this.host.c, { ...common, legacy: { groupId, channel: session } });
    } else {
      // Internet: the room (L0) authenticated the peer; the link must stay that member.
      link.mux = new LinkMux(this.host.c, { ...common, identity: peer.id });
    }
    this.links.set(conn.id, link);
    this.handle(link, link.mux.takeEvents());
    this.pump(link);
  }

  private attachLegacy(conn: SimConn, side: 'initiator' | 'responder'): void {
    const groupId = this.activeGroup!;
    const store = this.store(groupId);
    const options = { now: this.now, limits: LAN_LIMITS };
    let session: SyncSession;
    let first: Step | undefined;
    if (side === 'initiator') {
      const r = SyncSession.initiate(this.host.c, store, options);
      session = r.session;
      first = r.step;
    } else {
      session = SyncSession.respond(this.host.c, store, options);
    }
    const link: LegacyLink = { kind: 'v1', conn, groupId, session };
    this.links.set(conn.id, link);
    if (first !== undefined) this.legacyStep(link, first);
  }

  private store(groupId: string) {
    const r = this.groups.get(groupId)!;
    return capStore(r, (m) => this.host.claims(m));
  }

  private newSession(
    groupId: string,
    path: PathKind,
    side: 'initiator' | 'responder',
    maxFrameBytes: number,
  ): SyncSession | undefined {
    if (!this.groups.has(groupId)) return undefined;
    const options = {
      now: this.now,
      pull: true,
      linkUpgrade: path === 'nearby',
      rtc: path !== 'nearby',
      limits: channelLimits(limitsForPath(path), maxFrameBytes),
    };
    const store = this.store(groupId);
    if (side === 'responder') return SyncSession.respond(this.host.c, store, options);
    return SyncSession.initiate(this.host.c, store, options).session;
  }

  private channelFor(link: MuxLink, path: PathKind, req: ChannelRequest): SyncSession | undefined {
    if (req.cls !== 'sync') return undefined;
    const session = this.newSession(req.groupId, path, req.side, link.conn.model.maxFrameBytes);
    if (session !== undefined) link.sessions.set(req.groupId, session);
    return session;
  }

  // ── Network callbacks ─────────────────────────────────────────────────────

  onFrame(connId: string, data: Uint8Array): void {
    const link = this.links.get(connId);
    if (link === undefined) return;
    if (link.kind === 'v1') return this.legacyStep(link, link.session.receive(data, this.now));
    this.handle(link, link.mux.receive(data, this.now));
    this.pump(link);
  }

  onWritable(connId: string): void {
    const link = this.links.get(connId);
    if (link?.kind === 'mux') this.pump(link);
  }

  onClosed(connId: string, why: string): void {
    const link = this.links.get(connId);
    if (link === undefined) return;
    this.links.delete(connId);
    this.stats.closed.push({ conn: connId, why });
    if (link.kind === 'mux') {
      link.mux.close(why, this.now);
      this.handle(link, link.mux.takeEvents());
    } else {
      link.session.close(why);
    }
  }

  /** Periodic re-sync: every link's tick. */
  tick(): void {
    for (const link of [...this.links.values()]) {
      if (link.kind === 'v1') this.legacyStep(link, link.session.tick(this.now));
      else {
        this.handle(link, link.mux.tick(this.now));
        this.pump(link);
      }
    }
  }

  // ── Writing ───────────────────────────────────────────────────────────────

  /** Write a record and push it live on every link carrying the group, on its lane. */
  write(
    groupId: string,
    kind: string,
    id: string,
    fields: Record<string, Json>,
    options: { pr?: 1 | 2 } = {},
  ): SignedOp | undefined {
    const r = this.groups.get(groupId);
    if (r === undefined) return undefined;
    const op = r.write(this.now, 'e.set', { k: kind, id, f: fields }, options);
    if (op === undefined) return undefined;
    const lane = laneOfWrite({ type: 'e.set', kind, ...(options.pr ? { pr: options.pr } : {}) });
    this.broadcast(groupId, [op], lane);
    return op;
  }

  /** Share a position (ephemeral). */
  position(groupId: string, lat: number, lon: number): SignedOp | undefined {
    const r = this.groups.get(groupId);
    const op = r?.position(this.now, { ll: [lat, lon] }, 600);
    if (op !== undefined) this.broadcast(groupId, [op], LANE_LIVE);
    return op;
  }

  /** Push ops on every live link carrying `groupId` (except the one they came from). */
  broadcast(groupId: string, ops: readonly SignedOp[], lane: Lane, except?: string): void {
    if (ops.length === 0) return;
    for (const link of [...this.links.values()]) {
      if (link.conn.id === except) continue;
      if (link.kind === 'v1') {
        if (link.groupId === groupId) this.legacyStep(link, link.session.push(ops, this.now));
        continue;
      }
      const s = link.sessions.get(groupId);
      if (s === undefined || s.phase !== 'open') continue;
      s.push(ops, this.now, lane);
      this.pump(link);
    }
  }

  /** The lane an op relayed from another phone goes out on (we can read its kind). */
  private relayLane(groupId: string, op: SignedOp): Lane {
    if (op.env.t !== 'e.set' && op.env.t !== 'e.del') {
      return laneOfWrite({ type: op.env.t, ...(op.env.pr ? { pr: op.env.pr } : {}) });
    }
    const body = this.groups.get(groupId)?.decode(op);
    const kind = isRecord(body) && typeof body['k'] === 'string' ? body['k'] : undefined;
    return laneOfWrite({
      type: op.env.t,
      ...(kind === undefined ? {} : { kind }),
      ...(op.env.pr ? { pr: op.env.pr } : {}),
    });
  }

  private relay(groupId: string, ops: readonly SignedOp[], from: string): void {
    const byLane: SignedOp[][] = [[], [], [], []];
    for (const op of ops) byLane[this.relayLane(groupId, op)]!.push(op);
    for (const l of LANES) this.broadcast(groupId, byLane[l]!, l, from);
  }

  // ── Plumbing ──────────────────────────────────────────────────────────────

  private count(event: SessionEvent): void {
    this.stats.events[event.type] = (this.stats.events[event.type] ?? 0) + 1;
  }

  private legacyStep(link: LegacyLink, step: Step): void {
    // 2.6 sessions seal at once: their frames leave in order, never held.
    for (const f of step.send) this.host.net.send(link.conn, this, f);
    for (const event of step.events) {
      this.count(event);
      if (event.type === 'strike') {
        this.stats.strikes.push({
          conn: link.conn.id,
          reason: event.reason,
          version: this.version,
        });
      }
      if (event.type === 'ingested') this.relay(link.groupId, event.report.accepted, link.conn.id);
      if (event.type === 'admitted') this.relay(link.groupId, [event.op], link.conn.id);
    }
    if (link.session.phase === 'closed' && this.links.has(link.conn.id)) {
      this.links.delete(link.conn.id);
      this.host.net.cut(link.conn, 'session-closed');
    }
  }

  private handle(link: MuxLink, events: readonly LinkEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case 'session': {
          this.count(e.event);
          const ev = e.event;
          if (ev.type === 'strike') {
            this.stats.strikes.push({
              conn: link.conn.id,
              reason: ev.reason,
              version: this.version,
            });
          } else if (ev.type === 'ingested') {
            this.relay(e.groupId, ev.report.accepted, link.conn.id);
          } else if (ev.type === 'admitted') {
            this.relay(e.groupId, [ev.op], link.conn.id);
          } else if (ev.type === 'open' && e.ch === 0 && link.side === 'initiator') {
            // A LAN link between two 2.7 phones upgrades to mux framing.
            link.sessions.get(e.groupId)?.requestUpgrade(this.now);
          } else if (ev.type === 'upgrade') {
            this.stats.upgrades++;
          }
          break;
        }
        case 'ready':
        case 'framing':
          // Initiator: carry every group we hold (the peer refuses the others).
          if (link.side === 'initiator' && link.mux.state === 'open') {
            for (const g of this.groups.keys()) link.mux.open(g);
          }
          break;
        case 'channel-closed':
          link.sessions.delete(e.groupId);
          break;
        case 'strike':
          this.stats.strikes.push({ conn: link.conn.id, reason: e.reason, version: this.version });
          break;
        case 'closed':
          if (this.links.get(link.conn.id) === link) {
            this.links.delete(link.conn.id);
            this.stats.closed.push({ conn: link.conn.id, why: e.why });
            this.host.net.cut(link.conn, e.why);
          }
          break;
        default:
          break;
      }
    }
  }

  /** Hand frames to the network while the carrier has room (shallow queue). */
  pump(link: MuxLink): void {
    if (this.hold || !link.conn.open) return;
    while (link.conn.room(this) > 0) {
      const f = link.mux.next(this.now);
      if (f === undefined) break;
      this.host.net.send(link.conn, this, f);
    }
    this.handle(link, link.mux.takeEvents());
    // Paced: come back when the link may send again (one timer per link).
    const delay = link.conn.room(this) > 0 ? link.mux.nextSendDelay(this.now) : undefined;
    if (delay !== undefined && delay > 0 && !link.paceTimer) {
      link.paceTimer = true;
      this.host.clock.after(delay, () => {
        link.paceTimer = false;
        if (this.links.get(link.conn.id) === link) this.pump(link);
      });
    }
  }

  /** Release {@link hold} and send what waited. */
  release(): void {
    this.hold = false;
    for (const link of this.links.values()) if (link.kind === 'mux') this.pump(link);
  }

  muxLinks(): MuxLink[] {
    return [...this.links.values()].filter((l): l is MuxLink => l.kind === 'mux');
  }
}
