/**
 * Every sync group on this phone (2.7.0 design §3.3 and §5.5, #705): the
 * device keys, the group records, one open `TeamSession` (replica, store,
 * team domain) per group, and the phone's links ({@link LinkHost}), which
 * carry every group two phones share.
 *
 * Since 2.7.0 every group the phone is in is loaded at launch and replicated
 * whenever a link carries it; which team the screens show (the "active"
 * team, `TeamService`) is a UI concept. The LAN still advertises one tag at
 * a time — the active team's — so links form between phones showing the same
 * team, and the other groups the two share ride those links as channels. A
 * multi-tag advert needs a native change (2.7.x, design §8.3).
 *
 * Kept from 2.6: the disk layout (`teams/index.json`, one log per team),
 * the join flow (`JoinAttempt` owns the transport while it runs, so the links
 * stop meanwhile), and every team action (`TeamSession`).
 */
import type { Carrier } from '@core/group/link';
import { inviteRooms } from '@core/group/invites';
import { groupMeta, internetOn } from '@core/group/meta';
import type { PathPolicy } from '@core/group/path';
import { provisionalJoinOf } from '@core/group/provisional';
import type { IceServer } from '@core/group/roomProto';
import type { MeshNetworkInfo } from '@core/mesh/hotspot';
import { createTeam } from '@core/team/actions';
import { fromB64uLen, toB64u } from '@core/team/bytes';
import { generateDeviceKeys, KEY_BYTES, type DeviceKeys, type TeamCrypto } from '@core/team/crypto';
import type { SignedOp } from '@core/team/envelope';
import { memberIdOf } from '@core/team/ids';
import type { InviteToken } from '@core/team/invite';
import type { Role } from '@core/team/roles';
import type { TeamAlert } from '@core/teamui/alerts';
import type { OpenLink, PathView } from '@core/teamui/links';
import { cleanName, nameText, SYS_PROFILE, systemMessage } from '@core/teamui/system';
import { addBreadcrumb, reportError } from '@lib/errorReporting';

import type { MeshLinkStatus } from '@data/team/meshLink';
import type { MeshStats, MeshTransport } from '@data/team/meshTransport';
import { DEFAULT_TEAM_PREFS, type TeamDisk, type TeamRecord } from '@data/team/teamDisk';
import type { SessionDrawAlert } from '@data/team/teamDraw';
import { JoinAttempt } from '@data/team/teamJoin';
import {
  TeamSession,
  type ActionError,
  type NetPeer,
  type SessionNet,
} from '@data/team/teamSession';

import { loadRtcModule, type RtcModuleLike } from './carriers/rtcModule';
import {
  globalTimers,
  LinkHost,
  type IdentityOf,
  type LinkSnapshot,
  type Timers,
} from './linkHost';
import { PathManager, type PathGroup, type PeerPathStatus } from './pathManager';
import type { WebSocketFactory } from './roomClient';

/**
 * Internet paths (G6): the relay's host and how to reach it. Absent, the
 * phone is nearby-only, as 2.6 (and so is a binary without WebRTC).
 */
export interface InternetDeps {
  /** The `inukshuk-rtc` host (the owner's relay account). */
  host: string;
  ws: WebSocketFactory;
  /** `react-native-webrtc` (default: loaded lazily; null keeps the phone nearby-only). */
  rtc?: RtcModuleLike | null;
  stun?: IceServer[];
  /** Room connect jitter (R-META-4; tests: 0). */
  jitterMs?: number;
  /** Decision tick (ms; 0: tests tick by hand). */
  evalMs?: number;
  policy?: Partial<PathPolicy>;
  random?: () => number;
}

export interface HostDeps {
  c: TeamCrypto;
  disk: TeamDisk;
  transport: MeshTransport | null;
  now?: () => number;
  /** Re-sync period of the links (ms); 0 when tests tick by hand. */
  tickMs?: number;
  /** Timers for the links' pacing and tick (tests pass a manual clock's). */
  timers?: Timers;
  /** The mesh's frame cap when the transport was configured below the default. */
  meshFrameBytes?: number;
  /** Internet paths (G6); absent: nearby only. */
  internet?: InternetDeps;
}

/** What the host reports up, per group (the team façade filters by the active team). */
export interface HostHooks {
  onChange(): void;
  onAlert(alert: TeamAlert, groupId: string): void;
  onDraw(groupId: string): void;
  onDrawAlert(alert: SessionDrawAlert, groupId: string): void;
  /** Whether the screens show this group (alerts and receipts are for it only). */
  foreground(groupId: string): boolean;
}

/** One group's internet for the screens (`GroupHost.groupNet`). */
export interface GroupNetView {
  capable: boolean;
  online: boolean;
  /** The group's own room (`PathManager.roomState`). */
  room: 'ready' | 'failing' | 'trying' | 'none';
  links: OpenLink[];
  paths: PathView[];
}

/** One group, as a list shows it (design §5.5 `GroupSummary`). */
export interface GroupSummary {
  id: string;
  /** `gmeta.app`; a group without one is a team. */
  app: string;
  name: string;
  role: Role | undefined;
  /** Whether a session is loaded for it. */
  open: boolean;
}

export class GroupHost implements SessionNet {
  private keys: DeviceKeys | null = null;
  private records: TeamRecord[] = [];
  private readonly sessions = new Map<string, TeamSession>();
  private readonly opening = new Map<string, Promise<TeamSession>>();
  private joining: JoinAttempt | null = null;
  private joinName = '';
  private loaded: Promise<void> | null = null;
  private readonly linkHost: LinkHost | null;
  private readonly paths: PathManager | null = null;
  readonly now: () => number;

  constructor(
    private readonly deps: HostDeps,
    private readonly hooks: HostHooks,
  ) {
    this.now = deps.now ?? Date.now;
    const transport = deps.transport;
    this.linkHost =
      transport === null
        ? null
        : new LinkHost({
            c: deps.c,
            transport,
            me: () => (this.keys !== null ? memberIdOf(this.keys.signPublic) : ''),
            groups: () => [...this.sessions.keys()],
            group: (id) => this.sessions.get(id),
            now: this.now,
            ...(deps.tickMs !== undefined ? { tickMs: deps.tickMs } : {}),
            ...(deps.timers !== undefined ? { timers: deps.timers } : {}),
            ...(deps.meshFrameBytes !== undefined ? { meshFrameBytes: deps.meshFrameBytes } : {}),
            onChange: () => this.hooks.onChange(),
            onDiag: (event) => addBreadcrumb(`team link: ${event}`),
          });
    const internet = deps.internet;
    const rtc =
      internet === undefined ? null : internet.rtc === undefined ? loadRtcModule() : internet.rtc;
    if (this.linkHost !== null && internet !== undefined && rtc !== null) {
      this.paths = new PathManager({
        c: deps.c,
        host: internet.host,
        links: this.linkHost,
        groups: () => this.pathGroups(),
        me: () => (this.keys !== null ? memberIdOf(this.keys.signPublic) : ''),
        ws: internet.ws,
        rtc,
        now: this.now,
        timers: deps.timers ?? globalTimers,
        ...(internet.random ? { random: internet.random } : {}),
        ...(internet.jitterMs !== undefined ? { jitterMs: internet.jitterMs } : {}),
        ...(internet.policy ? { policy: internet.policy } : {}),
        ...(internet.stun ? { stun: internet.stun } : {}),
        ...(internet.evalMs !== undefined ? { evalMs: internet.evalMs } : {}),
        forceRelay: () => [...this.sessions.values()].some((s) => s.provisional),
        onChange: () => this.hooks.onChange(),
        onDiag: (event) => addBreadcrumb(`team net: ${event}`),
      });
    }
  }

  // ── Internet paths (G6) ──────────────────────────────────────────────────

  /** Every group as the path manager sees it: its `net` switch, parent and epoch key. */
  private pathGroups(): PathGroup[] {
    const now = this.now();
    const out: PathGroup[] = [];
    for (const [groupId, s] of this.sessions) {
      const data = s.replica.data(now);
      const meta = groupMeta(data);
      const net = internetOn(data);
      out.push({
        groupId,
        store: s.store,
        net,
        ...(meta.parent !== undefined ? { parent: meta.parent } : {}),
        epochKey: s.replica.sendKey()?.key,
        // Let joiners in through their invites' rooms (G7); a provisional
        // phone admits nobody (its own log is not vouched for yet).
        ...(net && !s.provisional ? { invites: inviteRooms(data, s.replica.state, now) } : {}),
      });
    }
    return out;
  }

  /** Whether this build can use internet paths at all (relay configured, WebRTC present). */
  get internetCapable(): boolean {
    return this.paths !== null;
  }

  /**
   * The app is in use (foreground, or recording): rooms open for every group
   * whose internet switch is on (R-META-4). Off: every room and internet path closes.
   */
  setInternetOnline(on: boolean): void {
    this.paths?.setOnline(on);
  }

  /** "Always use the relay" (per phone, R-RTC-6). */
  setAlwaysRelay(on: boolean): void {
    this.paths?.setAlwaysRelay(on);
  }

  /** Per peer: which path carries sync, and what each path is doing (G7's Connection sheet). */
  internetStatus(): PeerPathStatus[] {
    return this.paths?.status() ?? [];
  }

  /**
   * One group's internet, as the screens show it (G7): whether this build can,
   * whether the phone is in its room, the open links that carry it and what
   * the path manager is doing per member.
   */
  groupNet(groupId: string): GroupNetView {
    const links: OpenLink[] = [];
    for (const l of this.links()) {
      if (l.state === 'open' && l.identity !== undefined && l.groups.includes(groupId))
        links.push({ member: l.identity, path: l.path });
    }
    const paths: PathView[] = this.internetStatus().map((p) => ({
      member: p.member,
      primary: p.primary,
      signalling: p.signalling,
      connecting: Object.values(p.paths).some((s) => s === 'connecting'),
    }));
    return {
      capable: this.paths !== null,
      online: this.paths?.isOnline ?? false,
      room: this.paths?.roomState(groupId) ?? 'none',
      links,
      paths,
    };
  }

  /** Run the path decisions now (tests; the manager ticks by itself otherwise). */
  tickPaths(): void {
    this.paths?.tick();
  }

  // ── Groups ───────────────────────────────────────────────────────────────

  /** Read the group list and open every group's session (once). */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      this.records = await this.deps.disk.loadTeams();
      if (this.records.length > 0) {
        await Promise.all(this.records.map((r) => this.ensure(r.teamId).catch(() => undefined)));
      }
      this.hooks.onChange();
    })();
    return this.loaded;
  }

  get teams(): readonly TeamRecord[] {
    return this.records;
  }

  get join(): JoinAttempt | null {
    return this.joining;
  }

  /** A loaded group's session. */
  open(groupId: string): TeamSession | undefined {
    return this.sessions.get(groupId);
  }

  /** Every group with what a list shows of it. */
  groups(): GroupSummary[] {
    const now = this.now();
    return this.records.map((r) => {
      const s = this.sessions.get(r.teamId);
      return {
        id: r.teamId,
        app: s ? groupMeta(s.replica.data(now)).app : 'team',
        name: r.name,
        role: s?.myRole,
        open: s !== undefined,
      };
    });
  }

  /** The links, for diagnostics and tests. */
  links(): LinkSnapshot[] {
    return this.linkHost?.snapshot() ?? [];
  }

  /** The link layer itself (the path manager and tests); null without a mesh. */
  get linkLayer(): LinkHost | null {
    return this.linkHost;
  }

  /**
   * Carry links over another carrier (G6's internet paths): mux from the
   * first frame, bound to the member the rendezvous authenticated. Without a
   * mesh in this build there are no links at all (returns a no-op).
   */
  attachCarrier(carrier: Carrier, identityOf: IdentityOf): () => void {
    return this.linkHost?.attachCarrier(carrier, identityOf) ?? (() => undefined);
  }

  /** A group's session, opened from disk if it is not yet (a failed open at launch retries here). */
  async ensure(groupId: string): Promise<TeamSession> {
    const open = this.sessions.get(groupId);
    if (open !== undefined) return open;
    const pending = this.opening.get(groupId);
    if (pending !== undefined) return pending;
    const record = this.records.find((r) => r.teamId === groupId);
    if (record === undefined) throw new Error('Unknown team');
    const p = (async () => {
      try {
        const session = await TeamSession.open(
          this.sessionDeps(groupId),
          record,
          await this.deviceKeys(),
        );
        session.onRecordChange = (r) => this.putRecord(r);
        this.sessions.set(groupId, session);
        this.linkHost?.groupsChanged();
        this.paths?.refresh();
        return session;
      } catch (e) {
        reportError(e, 'team-open');
        throw e;
      } finally {
        this.opening.delete(groupId);
      }
    })();
    this.opening.set(groupId, p);
    return p;
  }

  /** Found a team (its genesis on disk, its record kept, its session open). */
  async create(options: {
    name: string;
    myName: string;
    lifetimeMs: number;
  }): Promise<{ session: TeamSession; key: Parameters<TeamSession['replica']['addKey']>[0] }> {
    await this.load();
    const name = cleanName(options.name);
    const myName = cleanName(options.myName);
    if (name === null || myName === null) throw new Error('A team and a display name are needed');
    const keys = await this.deviceKeys();
    const now = this.now();
    const team = createTeam(this.deps.c, keys, now, { name, lifetimeMs: options.lifetimeMs });
    // Genesis to disk before anything else (the chain starts here).
    this.deps.disk.appendOps(team.teamId, [team.genesis.env]);
    this.deps.disk.saveCursor(team.teamId, team.writer.cursor);
    this.putRecord({
      teamId: team.teamId,
      name,
      myName,
      joinedAt: now,
      prefs: { ...DEFAULT_TEAM_PREFS },
      lastReadAt: 0,
    });
    return { session: await this.ensure(team.teamId), key: team.key };
  }

  /**
   * Delete a group from this phone: its sessions end, its log is deleted.
   * What others already have stays on their phones.
   */
  async remove(groupId: string): Promise<void> {
    await this.load();
    await this.stop(groupId);
    this.sessions.delete(groupId);
    this.linkHost?.dropGroup(groupId, 'left');
    this.paths?.refresh();
    this.deps.disk.deleteTeam(groupId);
    this.records = this.records.filter((r) => r.teamId !== groupId);
    this.saveRecords();
    this.hooks.onChange();
  }

  putRecord(record: TeamRecord): void {
    const i = this.records.findIndex((r) => r.teamId === record.teamId);
    if (i >= 0) this.records[i] = record;
    else this.records.push(record);
    this.records = [...this.records];
    this.saveRecords();
  }

  private saveRecords(): void {
    this.deps.disk.saveTeams(this.records);
  }

  // ── Joining ──────────────────────────────────────────────────────────────

  /** Start joining with an invite; the links stop meanwhile (the join owns the transport). */
  async startJoin(token: InviteToken, myName: string, tickMs?: number): Promise<JoinAttempt> {
    await this.load();
    const name = cleanName(myName);
    if (name === null) throw new Error('A display name is needed');
    if (this.records.some((r) => r.teamId === token.teamId)) throw new Error('already-member');
    await this.cancelJoin();
    await this.linkHost?.stop();
    const attempt = new JoinAttempt(
      {
        c: this.deps.c,
        disk: this.deps.disk,
        transport: this.deps.transport,
        now: this.now,
        onChange: () => this.hooks.onChange(),
        ...(tickMs !== undefined ? { tickMs } : {}),
        ...(this.paths !== null && this.deps.internet !== undefined
          ? {
              internet: {
                host: this.deps.internet.host,
                ws: this.deps.internet.ws,
                timers: this.deps.timers ?? globalTimers,
                ...(this.deps.internet.jitterMs !== undefined
                  ? { jitterMs: this.deps.internet.jitterMs }
                  : {}),
                ...(this.deps.internet.random ? { random: this.deps.internet.random } : {}),
              },
            }
          : {}),
      },
      token,
      await this.deviceKeys(),
    );
    this.joining = attempt;
    this.joinName = name;
    await attempt.start();
    this.hooks.onChange();
    return attempt;
  }

  /** Abandon a join: its data is deleted. */
  async cancelJoin(): Promise<void> {
    const attempt = this.joining;
    if (attempt === null) return;
    this.joining = null;
    await attempt.stop();
    if (!this.records.some((r) => r.teamId === attempt.teamId)) {
      this.deps.disk.deleteTeam(attempt.teamId);
    }
    this.hooks.onChange();
  }

  /**
   * Keep the group, post my name, open its session. `compared`: the two
   * people compared the safety code. An internet join without it stays
   * provisional (R-INV-4) until another member vouches for the log.
   */
  async confirmJoin(compared = true): Promise<TeamSession | ActionError> {
    const attempt = this.joining;
    if (attempt === null || !attempt.admitted) return 'not-member';
    const provisional =
      !compared && attempt.viaInternet
        ? provisionalJoinOf(attempt.replica.state, attempt.replica.id)
        : undefined;
    // Write my name through the join's store (same log, same cursor on disk).
    attempt.writeOwn(() =>
      attempt.replica.write(
        this.now(),
        'msg',
        systemMessage(toB64u(this.deps.c.randomBytes(9)), SYS_PROFILE, nameText(this.joinName)),
      ),
    );
    this.joining = null;
    await attempt.stop();
    this.putRecord({
      teamId: attempt.teamId,
      name: 'Team',
      myName: this.joinName,
      joinedAt: this.now(),
      prefs: { ...DEFAULT_TEAM_PREFS },
      lastReadAt: 0,
      ...(attempt.replica.state.sendKeyId ? { profileKeyId: attempt.replica.state.sendKeyId } : {}),
      ...(provisional !== undefined ? { provisional } : {}),
    });
    return this.ensure(attempt.teamId);
  }

  // ── Device identity ──────────────────────────────────────────────────────

  /** This device's keys, created on first group use and kept in the secure store. */
  async deviceKeys(): Promise<DeviceKeys> {
    if (this.keys) return this.keys;
    const c = this.deps.c;
    const saved = await this.deps.disk.loadDevice();
    if (this.keys) return this.keys;
    const sign = saved ? fromB64uLen(saved.sign, KEY_BYTES) : undefined;
    const box = saved ? fromB64uLen(saved.box, KEY_BYTES) : undefined;
    if (sign && box) {
      this.keys = {
        signSecret: sign,
        signPublic: c.ed25519.publicKey(sign),
        boxSecret: box,
        boxPublic: c.x25519.publicKey(box),
      };
      return this.keys;
    }
    const fresh = generateDeviceKeys(c);
    const ok = await this.deps.disk.saveDevice({
      v: 1,
      sign: toB64u(fresh.signSecret),
      box: toB64u(fresh.boxSecret),
    });
    // Without a key that survives a relaunch, every group would fork on restart.
    if (!ok) throw new Error('Could not save the team key in the secure store');
    this.keys ??= fresh;
    return this.keys;
  }

  private sessionDeps(groupId: string) {
    return {
      c: this.deps.c,
      disk: this.deps.disk,
      net: this.linkHost === null ? null : (this as SessionNet),
      now: this.now,
      newId: () => toB64u(this.deps.c.randomBytes(9)),
      foreground: () => this.hooks.foreground(groupId),
      onChange: () => this.hooks.onChange(),
      onAlert: (alert: TeamAlert) => this.hooks.onAlert(alert, groupId),
      onDraw: () => this.hooks.onDraw(groupId),
      onDrawAlert: (alert: SessionDrawAlert) => this.hooks.onDrawAlert(alert, groupId),
    };
  }

  // ── The links (`SessionNet`) ─────────────────────────────────────────────

  async start(groupId: string): Promise<void> {
    if (this.joining !== null) return;
    await this.linkHost?.start(groupId);
  }

  async stop(groupId: string): Promise<void> {
    if (this.linkHost?.advertised === groupId) await this.linkHost.stop();
  }

  running(groupId: string): boolean {
    return this.linkHost !== null && this.linkHost.running && this.linkHost.advertised === groupId;
  }

  status(groupId: string): MeshLinkStatus | null {
    return this.running(groupId) ? (this.linkHost?.status() ?? null) : null;
  }

  manualDials(): string[] {
    return this.linkHost?.manualDials ?? [];
  }

  dial(groupId: string, host: string, port: number): boolean {
    return this.running(groupId) && (this.linkHost?.dial(host, port) ?? false);
  }

  tick(): void {
    this.linkHost?.tick();
  }

  push(groupId: string, ops: readonly SignedOp[], except: string | null): void {
    this.linkHost?.push(groupId, ops, except);
  }

  peers(groupId: string): NetPeer[] {
    return this.linkHost?.peers(groupId) ?? [];
  }

  closeMember(memberId: string, why: string): void {
    this.linkHost?.closeMember(memberId, why);
  }

  stats(): MeshStats | null {
    try {
      return this.deps.transport?.stats() ?? null;
    } catch {
      return null;
    }
  }

  /** The network this phone is on (hotspot fallback hints); null without a mesh. */
  networkInfo(): MeshNetworkInfo | null {
    try {
      return this.deps.transport?.networkInfo() ?? null;
    } catch {
      return null;
    }
  }
}
