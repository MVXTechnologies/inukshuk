/**
 * One team on this phone, open (#589): the replica restored from disk, every
 * team action, and its sync sessions. Since 2.7.0 (G5) every team the phone
 * is in is open at once inside the `GroupHost`, and the connections belong to
 * the host's links (`@data/sync/linkHost`), which carry each team as a
 * channel; this class is the team domain over one group: it reacts to its
 * sessions' events and pushes its writes through the host
 * ({@link SessionNet}). Platform-free, so the two-peer tests run it over the
 * loopback hub.
 *
 * Every write goes replica → disk (`PersistingStore`) → peers, in that order.
 */
import { invitesToRevoke, irdvFields } from '@core/group/invites';
import { GROUP_RECORD_ID, internetOn, IRDV, NET } from '@core/group/meta';
import { joinConfirmed } from '@core/group/provisional';
import type { PathKind } from '@core/group/path';
import type { MeshNetworkInfo } from '@core/mesh/hotspot';
import { addBreadcrumb, reportError } from '@lib/errorReporting';
import { createInvite, rotateBody } from '@core/team/actions';
import type { Json } from '@core/team/canonical';
import type { DeviceKeys, TeamCrypto } from '@core/team/crypto';
import type { SignedOp } from '@core/team/envelope';
import { encodeInvite, type InviteToken, type NetHint } from '@core/team/invite';
import { activeMembers, cutFor } from '@core/team/membership';
import { sosCoolingDown } from '@core/team/records';
import { TeamReplica } from '@core/team/replica';
import type { Audience, GroupLink, Priority, Role } from '@core/team/roles';
import type { SessionEvent, SessionOptions, SyncSession } from '@core/team/sync';
import { alertContext, alertFor, TaskAlertThrottle, type TeamAlert } from '@core/teamui/alerts';
import { commentsByPhoto, type Said } from '@core/teamui/mapMarks';
import { teamRally, teamSos, type TeamRally, type TeamSos } from '@core/teamui/field';
import {
  owesReceipt,
  receiptBody,
  receiptCount,
  type AlertRef,
  type ReceiptCount,
} from '@core/teamui/receipts';
import { teamThreads, type ThreadRow } from '@core/teamui/threads';
import { editors, editText, SYS_EDIT, teamTrails, type TeamTrailView } from '@core/teamui/trails';
import { pinThread, resolvedMessages, teamPins, type TeamPin } from '@core/teamui/pins';
import {
  statusFields,
  canEditTask,
  cleanTaskNotes,
  taskEditWrites,
  taskFields,
  taskNotesFields,
  teamTasks,
  validTaskFields,
  type NewTask,
  type TaskEdit,
  type TeamTask,
} from '@core/team/tasks';
import {
  photoComments,
  teamPhotos,
  trailComments,
  trailThread,
  type TeamComment,
  type TeamPhoto,
} from '@core/teamui/comments';
import { extendedExpiry } from '@core/teamui/lifetime';
import { inviteExpiresAt, ipv4Tuple, type InviteChoice } from '@core/teamui/invites';
import { teammatePositions, type TeammatePosition } from '@core/teamui/positions';
import {
  teamShares,
  trackFields,
  waypointFields,
  type ShareableTrack,
  type ShareableWaypoint,
  type TeamShares,
  encodePolyline,
} from '@core/teamui/shares';
import {
  cleanName,
  nameText,
  SYS_LEAVE,
  SYS_PROFILE,
  SYS_TEAM,
  systemMessage,
  memberStatuses,
  statusText,
  SYS_STATUS,
  type MemberStatus,
  type StatusId,
} from '@core/teamui/system';
import { buildTeamView, TEAM_THREAD, unreadCount, type TeamView } from '@core/teamui/view';
import { isPrivateIPv4, parseIPv4 } from '@core/mesh/hotspot';

import type { MeshLinkStatus } from './meshLink';
import type { MeshStats } from './meshTransport';
import { PersistingStore } from './persistingStore';
import { onlyPens, SessionDrawing, type SessionDrawAlert } from './teamDraw';
import type { TeamDisk, TeamRecord } from './teamDisk';

/** A team's session on one connection, as the host's links report it. */
export interface NetPeer {
  connId: string;
  direction: 'in' | 'out';
  host: string;
  session: SyncSession;
}

/**
 * What a team sees of the phone's links (`GroupHost`, 2.7.0 G5). The LAN
 * advertises one team's tag at a time (the active one); every link carries
 * every team the two phones share.
 */
export interface SessionNet {
  /** Run the LAN advertising this team (stops advertising any other). */
  start(teamId: string): Promise<void>;
  /** Stop the LAN if it advertises this team. */
  stop(teamId: string): Promise<void>;
  /** Whether the LAN runs advertising this team. */
  running(teamId: string): boolean;
  status(teamId: string): MeshLinkStatus | null;
  manualDials(): string[];
  dial(teamId: string, host: string, port: number): boolean;
  /** Re-sync every link now. */
  tick(): void;
  /** Push this team's ops on its open sessions (except the connection they came from). */
  push(teamId: string, ops: readonly SignedOp[], except: string | null): void;
  peers(teamId: string): NetPeer[];
  /** Hang up on a member's phone. */
  closeMember(memberId: string, why: string): void;
  stats(): MeshStats | null;
  networkInfo(): MeshNetworkInfo | null;
}

export interface SessionDeps {
  c: TeamCrypto;
  disk: TeamDisk;
  /** The host's links; null without a mesh in this build. */
  net: SessionNet | null;
  now: () => number;
  /**
   * Whether this team is the one the screens show (the active team). Alerts,
   * drawing alerts and receipts are for it only (other teams sync in the
   * background without ringing), except an SOS: an SOS from ANY of my teams
   * rings, with its receipt (owner decision 2026-10-16). Default: always.
   */
  foreground?: () => boolean;
  /** A fresh short id (messages, entities, groups). */
  newId: () => string;
  /** Something the UI shows changed. */
  onChange: () => void;
  /** A teammate's message routed `badge` or `alert` to me. */
  onAlert: (alert: TeamAlert) => void;
  /** Teammates' live strokes changed (#683): never through `onChange` (4 a second). */
  onDraw?: () => void;
  /** A teammate's drawing earned a snackbar or a notification (#683). */
  onDrawAlert?: (alert: SessionDrawAlert) => void;
}

export interface PeerStatus {
  peerId: string;
  memberId: string | null;
  direction: 'in' | 'out';
  host: string;
  phase: string;
  /** A joiner using an invite (responder side). */
  joining: boolean;
  safetyCode: string | null;
  connectedAt: number;
  lastFrameAt: number;
  bytesIn: number;
  bytesOut: number;
}

/** A join that happened through this phone: its safety code to compare out loud. */
export interface JoinNotice {
  peerId: string;
  code: string;
  at: number;
  /** Set once admitted. */
  memberId: string | null;
}

/** An action that could not run; `null` means it ran. */
export type ActionError =
  | 'read-only'
  | 'not-allowed'
  | 'rotation-pending'
  | 'not-member'
  | 'invalid'
  | 'too-large'
  | 'no-change';

/** Position ops live this long (the protocol caps ephemeral ops at 24 h). */
export const POSITION_TTL_S = 6 * 3600;

/** A team invite ready to share: its payload, and the QR text with the network hint. */
export interface CreatedInvite {
  token: InviteToken;
  /** For SMS and links (never the network hint). */
  payload: string;
  /** For the QR code shown in person (may carry this phone's address). */
  qrPayload: string;
}

interface PeerMeta {
  connectedAt: number;
  lastFrameAt: number;
  joining: boolean;
}

export class TeamSession {
  readonly store: PersistingStore;
  private readonly meta = new Map<string, PeerMeta>();
  /** Teammates whose phone stopped taking live strokes (#683, `SessionOptions.liveStrokeMute`). */
  private readonly liveStrokeMute = new Set<string>();
  readonly joinNotices: JoinNotice[] = [];
  /** Connections on which a joiner was admitted (peer id → member id). */
  private readonly admittedOn = new Map<string, string>();
  private cachedView: { at: number; view: TeamView } | null = null;
  private dirty = true;
  private profileCheckBusy = false;

  private constructor(
    private readonly deps: SessionDeps,
    readonly replica: TeamReplica,
    public record: TeamRecord,
  ) {
    this.store = new PersistingStore(replica, deps.disk);
    this.store.onStored = (ops) => this.afterStored(ops, null);
    this.draw = new SessionDrawing({
      replica,
      me: replica.id,
      now: deps.now,
      guardWrite: () => this.guardWrite(),
      run: (fn, ephemeral) => this.run(fn, ephemeral),
      dataVersion: () => this.dataVersion,
    });
  }

  /** Team drawing (#683): shapes, live strokes, `cap.pen`. */
  readonly draw: SessionDrawing;

  /**
   * Restore a team from disk. The writer resumes from the LATER of the saved
   * cursor and this device's own chain in the log (a crash between the op
   * append and the cursor save must not make it reuse a seq).
   */
  static async open(deps: SessionDeps, record: TeamRecord, keys: DeviceKeys): Promise<TeamSession> {
    const [envs, saved] = await Promise.all([
      deps.disk.loadOps(record.teamId),
      deps.disk.loadCursor(record.teamId),
    ]);
    const now = deps.now();
    let replica = new TeamReplica(deps.c, record.teamId, keys, saved ?? undefined);
    replica.autoRotate = true;
    replica.ingest(envs, now);
    const mine = replica.opsInRange(replica.id, 1, Number.MAX_SAFE_INTEGER);
    const head = mine[mine.length - 1];
    if (head !== undefined && mine.length > (saved?.seq ?? 0)) {
      const hlc =
        saved && saved.hlc.wall > head.stamp.wall
          ? saved.hlc
          : { wall: head.stamp.wall, counter: head.stamp.counter };
      replica = new TeamReplica(deps.c, record.teamId, keys, {
        seq: mine.length,
        hlc,
        prev: head.id,
      });
      replica.ingest(envs, now);
      deps.disk.saveCursor(record.teamId, replica.writer.cursor);
    }
    const session = new TeamSession(deps, replica, record);
    session.store.flush(now);
    return session;
  }

  get teamId(): string {
    return this.replica.teamId;
  }

  get me(): string {
    return this.replica.id;
  }

  // ── Views ────────────────────────────────────────────────────────────────

  view(): TeamView {
    const now = this.deps.now();
    if (!this.dirty && this.cachedView !== null && now - this.cachedView.at < 30_000) {
      return this.cachedView.view;
    }
    const view = buildTeamView({
      state: this.replica.state,
      data: this.replica.data(now),
      me: this.me,
      now,
      labels: (op) => this.replica.labels(op),
    });
    this.cachedView = { at: now, view };
    this.dirty = false;
    return view;
  }

  unread(): number {
    const done = this.resolved();
    return unreadCount(
      this.view().messages.filter((m) => !done.has(m.key.replace(/^msg:/, ''))),
      this.record.lastReadAt,
    );
  }

  private readonly taskThrottle = new TaskAlertThrottle();

  private sharesCache: { key: string; shares: TeamShares } | null = null;

  /** Stable identity while no data op arrived (the map re-serialises on change only). */
  shares(): TeamShares {
    const data = this.replica.data(this.deps.now());
    const key = `${this.replica.state.data.length}:${this.replica.fullFolds}`;
    if (this.sharesCache?.key !== key) this.sharesCache = { key, shares: teamShares(data) };
    return this.sharesCache.shares;
  }

  private photosCache: { key: string; photos: TeamPhoto[] } | null = null;

  /** Every shared trail photo (stable identity while no data op arrived). */
  photos(): TeamPhoto[] {
    const data = this.replica.data(this.deps.now());
    const key = `${this.replica.state.data.length}:${this.replica.fullFolds}`;
    if (this.photosCache?.key !== key) this.photosCache = { key, photos: teamPhotos(data) };
    return this.photosCache.photos;
  }

  /** A shared trail's comments: its own thread and its photos'. */
  trailComments(trackId: string): TeamComment[] {
    const ids = new Set(
      this.photos()
        .filter((p) => p.trackId === trackId)
        .map((p) => p.id),
    );
    return trailComments(this.replica.data(this.deps.now()), trackId, ids);
  }

  private pinsCache: { key: string; pins: TeamPin[] } | null = null;

  /** Every pin with its thread (stable identity while no data op arrived). */
  pins(): TeamPin[] {
    const data = this.replica.data(this.deps.now());
    if (this.pinsCache?.key !== this.dataVersion)
      this.pinsCache = { key: this.dataVersion, pins: teamPins(data) };
    return this.pinsCache.pins;
  }

  private threadsCache: { key: string; threads: Map<string, Said[]> } | null = null;

  /** Who commented on each shared photo, and when (the map's bubbles). */
  photoThreads(): Map<string, Said[]> {
    const data = this.replica.data(this.deps.now());
    if (this.threadsCache?.key !== this.dataVersion)
      this.threadsCache = { key: this.dataVersion, threads: commentsByPhoto(data) };
    return this.threadsCache.threads;
  }

  /**
   * Team chat's sub-threads (photo comments, pins, trail threads), open ones
   * first, newest activity first, with what I haven't seen yet.
   */
  threads(): ThreadRow[] {
    const data = this.replica.data(this.deps.now());
    return teamThreads({
      data,
      me: this.me,
      photos: this.photos(),
      pins: this.pins(),
      tracks: this.shares().tracks,
      resolved: this.resolved(),
      seenAt: (k) => this.seenAt(k),
    });
  }

  private statusCache: { key: string; at: number; map: Map<string, MemberStatus> } | null = null;

  /** Each member's newest quick status (OK, Arrived, Need help…). */
  statuses(): Map<string, MemberStatus> {
    const now = this.deps.now();
    if (this.statusCache?.key !== this.dataVersion || now - this.statusCache.at > 60_000) {
      this.statusCache = {
        key: this.dataVersion,
        at: now,
        map: memberStatuses(this.replica.data(now), now),
      };
    }
    return this.statusCache.map;
  }

  /** Post my quick status (guests too: a `sys:status` message). */
  setMyStatus(id: StatusId): ActionError | null {
    const blocked = this.guardWrite();
    if (blocked) return blocked;
    return this.writeMsg(systemMessage(this.deps.newId(), SYS_STATUS, statusText(id)));
  }

  private resolvedCache: { key: string; set: Set<string> } | null = null;

  /** `owner:id` of resolved messages (pins, notifies): off the map and the unread counts. */
  resolved(): Set<string> {
    if (this.resolvedCache?.key !== this.dataVersion)
      this.resolvedCache = {
        key: this.dataVersion,
        set: resolvedMessages(this.replica.data(this.deps.now())),
      };
    return this.resolvedCache.set;
  }

  /** Mark a message (a pin, a notify) resolved, or open it again. */
  resolveMessage(owner: string, id: string, res: boolean): ActionError | null {
    const blocked = this.guardWrite();
    if (blocked) return blocked;
    const now = this.deps.now();
    const body: Record<string, Json> = {
      k: 'mres',
      id,
      f: res ? { res: true, rby: this.me, rat: now } : { res: false, rby: null, rat: null },
    };
    if (owner !== this.me) body['o'] = owner;
    const op = this.run(() => this.replica.write(now, 'e.set', body));
    return op === undefined ? 'rotation-pending' : null;
  }

  private fieldCache: { key: string; sos: TeamSos[]; rally: TeamRally | null } | null = null;

  private field(): { sos: TeamSos[]; rally: TeamRally | null } {
    if (this.fieldCache?.key !== this.dataVersion) {
      const data = this.replica.data(this.deps.now());
      this.fieldCache = { key: this.dataVersion, sos: teamSos(data), rally: teamRally(data) };
    }
    return this.fieldCache;
  }

  /** Every live SOS, open ones first. */
  soses(): TeamSos[] {
    return this.field().sos;
  }

  /** The team's rally point (the newest), or null. */
  rally(): TeamRally | null {
    return this.field().rally;
  }

  /**
   * Raise an SOS at my position (anyone, guests too; one open at a time).
   *
   * For a minute after my last SOS was resolved (`SOS_COOLDOWN_MS`, the
   * spam guard), every phone's fold refuses a new SOS id, so the SOS reopens
   * my resolved one instead, at the new place and with the new text: no phone
   * (2.5.1 on) holds a reopen back, and it alerts the team like a raise
   * (QA 2.6.1: a new SOS seconds after "Resolve for everyone" was dropped).
   */
  raiseSos(lng: number, lat: number, text = ''): ActionError | null {
    const blocked = this.guardWrite();
    if (blocked) return blocked;
    const mine = this.soses().filter((s) => s.owner === this.me);
    if (mine.some((s) => !s.resolved)) return 'invalid';
    const now = this.deps.now();
    const tx = text.trim().slice(0, 200);
    const resolved = mine.find((s) => s.resolved);
    // `now` is never past the op's own stamp (an HLC only moves forward), so
    // when `now` is out of the cooldown, the write is too.
    const reopen =
      resolved !== undefined && sosCoolingDown(this.replica.data(now).index, this.me, now);
    const op = this.run(() =>
      reopen
        ? this.replica.write(now, 'e.set', {
            k: 'sos',
            id: resolved.id,
            f: { la: lat, lo: lng, tx, res: false, rby: null, rat: null },
          })
        : this.replica.write(now, 'e.set', {
            k: 'sos',
            id: this.deps.newId(),
            f: tx ? { la: lat, lo: lng, tx } : { la: lat, lo: lng },
          }),
    );
    if (op === undefined) return 'rotation-pending';
    return this.applied(op.id) ? null : 'not-allowed';
  }

  /** Move my open SOS with me (silent: no new alarm). */
  moveSos(id: string, lng: number, lat: number): void {
    if (this.guardWrite()) return;
    this.run(() =>
      this.replica.write(this.deps.now(), 'e.set', { k: 'sos', id, f: { la: lat, lo: lng } }),
    );
  }

  /** Resolve an SOS (its raiser or an admin). */
  resolveSos(owner: string, id: string): ActionError | null {
    const blocked = this.guardWrite();
    if (blocked) return blocked;
    const now = this.deps.now();
    const body: Record<string, Json> = { k: 'sos', id, f: { res: true, rby: this.me, rat: now } };
    if (owner !== this.me) body['o'] = owner;
    const op = this.run(() => this.replica.write(now, 'e.set', body));
    if (op === undefined) return 'rotation-pending';
    return this.applied(op.id) ? null : 'not-allowed';
  }

  /** Set the team's rally point (members); my previous one goes. */
  setRally(lng: number, lat: number, text = '', when: number | null = null): ActionError | null {
    const blocked = this.guardWrite();
    if (blocked) return blocked;
    if (!this.canEditShared()) return 'not-allowed';
    const mine = this.rally();
    const now = this.deps.now();
    const f: Record<string, Json> = { la: lat, lo: lng, r: 60, at: when };
    if (text.trim()) f['tx'] = text.trim().slice(0, 80);
    const op = this.run(() => {
      if (mine && mine.owner === this.me)
        this.replica.write(now, 'e.del', { k: 'rly', id: mine.id });
      return this.replica.write(now, 'e.set', { k: 'rly', id: this.deps.newId(), f });
    });
    return op === undefined ? 'rotation-pending' : null;
  }

  /** Clear the rally point (its creator or an admin). */
  clearRally(owner: string, id: string): ActionError | null {
    const blocked = this.guardWrite();
    if (blocked) return blocked;
    const op = this.run(() =>
      this.replica.write(this.deps.now(), 'e.del', { k: 'rly', id, o: owner }),
    );
    if (op === undefined) return 'rotation-pending';
    return this.applied(op.id) ? null : 'not-allowed';
  }

  /**
   * Receipts (#708): write one for every active teammate SOS or rally point
   * this phone holds and has not acknowledged yet. Called when ops arrive
   * from a peer, and on each team open; a no-op when nothing is owed, so a
   * resync never writes twice. Returns how many were written.
   */
  sendOwedReceipts(options: { sosOnly?: boolean } = {}): number {
    if (this.guardWrite() !== null || this.replica.state.sendKeyId === undefined) return 0;
    const data = this.replica.data(this.deps.now());
    const owed: AlertRef[] = [];
    for (const s of this.soses())
      if (!s.resolved) owed.push({ kind: 'sos', owner: s.owner, id: s.id });
    const r = options.sosOnly === true ? null : this.rally();
    if (r) owed.push({ kind: 'rly', owner: r.owner, id: r.id });
    const todo = owed.filter((a) => owesReceipt(data, this.me, a));
    if (todo.length === 0) return 0;
    const now = this.deps.now();
    this.run(() => {
      for (const a of todo) this.replica.write(now, 'e.set', receiptBody(a));
    });
    return todo.length;
  }

  /** Who has received one of my alerts ("3 of 5 received"). */
  receipts(alert: AlertRef): ReceiptCount {
    const now = this.deps.now();
    const active = this.view()
      .members.filter((m) => m.active)
      .map((m) => m.id);
    return receiptCount(this.replica.data(now), alert, active, now);
  }

  private trailsCache: { key: string; trails: TeamTrailView[] } | null = null;

  /** Team trails (editable by all members) with their current vertices. */
  teamTrails(): TeamTrailView[] {
    if (this.trailsCache?.key !== this.dataVersion)
      this.trailsCache = {
        key: this.dataVersion,
        trails: teamTrails(this.replica.data(this.deps.now())),
      };
    return this.trailsCache.trails;
  }

  /** Who is editing which team trail now (member → `owner:id`). */
  editors(): Map<string, string> {
    const now = this.deps.now();
    return editors(this.replica.data(now), now);
  }

  private writeOk(body: Json): ActionError | null {
    const blocked = this.guardWrite();
    if (blocked) return blocked;
    const op = this.run(() => this.replica.write(this.deps.now(), 'e.set', body));
    if (op === undefined) return 'rotation-pending';
    return this.applied(op.id) ? null : 'not-allowed';
  }

  /** Make a team trail from a line (members); returns its id or an error. */
  createTeamTrail(
    name: string,
    line: readonly [number, number][],
    src: { owner: string; id: string } | null = null,
  ): { id: string } | ActionError {
    if (!this.canEditShared()) return 'not-allowed';
    const pts =
      line.length > 400
        ? line.filter((_, i) => i % Math.ceil(line.length / 400) === 0 || i === line.length - 1)
        : [...line];
    if (pts.length < 2) return 'invalid';
    const id = this.deps.newId().replace(/_/g, '-').slice(0, 40);
    const f: Record<string, Json> = {
      name: name.trim().slice(0, 80) || 'Trail',
      base: encodePolyline(pts),
    };
    if (src) {
      f['so'] = src.owner;
      f['si'] = src.id;
    }
    const err = this.writeOk({ k: 'trl', id, f });
    return err ?? { id };
  }

  /** Move a vertex (base or inserted) of a team trail. */
  moveVertex(
    trail: { owner: string; id: string },
    vertexId: string,
    lng: number,
    lat: number,
    key?: string,
  ): ActionError | null {
    const f: Record<string, Json> = { to: trail.owner, tr: trail.id, la: lat, lo: lng };
    if (key !== undefined) f['k'] = key;
    return this.writeOk({ k: 'tve', id: vertexId, o: trail.owner, f });
  }

  /** Insert a vertex with key `key`; returns its id or an error. */
  insertVertex(
    trail: { owner: string; id: string },
    key: string,
    lng: number,
    lat: number,
  ): { id: string } | ActionError {
    const id = `${trail.id}_${this.deps.newId().replace(/_/g, '-').slice(0, 12)}`;
    const err = this.moveVertex(trail, id, lng, lat, key);
    return err ?? { id };
  }

  /** Delete a vertex of a team trail (members). */
  deleteVertex(trail: { owner: string; id: string }, vertexId: string): ActionError | null {
    const blocked = this.guardWrite();
    if (blocked) return blocked;
    const op = this.run(() =>
      this.replica.write(this.deps.now(), 'e.del', { k: 'tve', id: vertexId, o: trail.owner }),
    );
    if (op === undefined) return 'rotation-pending';
    return this.applied(op.id) ? null : 'not-allowed';
  }

  /** Rename, describe or recolour a team trail (members). */
  editTrailMeta(
    trail: { owner: string; id: string },
    f: { name?: string; desc?: string; color?: string },
  ): ActionError | null {
    const body: Record<string, Json> = { k: 'trl', id: trail.id, f: { ...f } };
    if (trail.owner !== this.me) body['o'] = trail.owner;
    return this.writeOk(body);
  }

  /** "I'm editing this trail" (null: done), for the others' presence cue. */
  setEditing(trail: { owner: string; id: string } | null): void {
    if (this.guardWrite()) return;
    this.writeMsg(
      systemMessage(
        this.deps.newId(),
        SYS_EDIT,
        editText(trail ? `${trail.owner}:${trail.id}` : null),
      ),
    );
  }

  private tasksCache: { key: string; tasks: TeamTask[] } | null = null;

  /** Every live task, newest first (stable identity while no data op arrived). */
  tasks(): TeamTask[] {
    const data = this.replica.data(this.deps.now());
    if (this.tasksCache?.key !== this.dataVersion)
      this.tasksCache = { key: this.dataVersion, tasks: teamTasks(data) };
    return this.tasksCache.tasks;
  }

  /** A fresh entity or message id (so a comment and the task made from it can refer to each other). */
  newId(): string {
    return this.deps.newId();
  }

  /** My role in this team, if I'm a member. */
  get myRole(): Role | undefined {
    return this.replica.state.members.get(this.me)?.role;
  }

  photoComments(photoId: string): TeamComment[] {
    return photoComments(this.replica.data(this.deps.now()), photoId);
  }

  /** A data counter for screens that read the session directly (changes on every stored op). */
  get dataVersion(): string {
    return `${this.replica.state.data.length}:${this.replica.fullFolds}`;
  }

  positions(): TeammatePosition[] {
    const now = this.deps.now();
    return teammatePositions(this.replica.data(now).positions, this.view().members, now);
  }

  peers(): PeerStatus[] {
    const net = this.deps.net;
    if (net === null || !net.running(this.teamId)) return [];
    const stats = net.stats();
    return net.peers(this.teamId).map((peer) => {
      const session = peer.session;
      const s = stats?.peers.find((p) => p.peerId === peer.connId);
      const m = this.meta.get(peer.connId);
      return {
        peerId: peer.connId,
        memberId: session.peer ?? null,
        direction: peer.direction,
        host: peer.host,
        phase: session.phase,
        joining: m?.joining ?? false,
        safetyCode: session.safetyCode ?? null,
        connectedAt: m?.connectedAt ?? 0,
        lastFrameAt: m?.lastFrameAt ?? 0,
        bytesIn: s?.bytesIn ?? 0,
        bytesOut: s?.bytesOut ?? 0,
      };
    });
  }

  meshStatus(): MeshLinkStatus | null {
    return this.deps.net?.status(this.teamId) ?? null;
  }

  get meshRunning(): boolean {
    return this.deps.net?.running(this.teamId) ?? false;
  }

  /** Recent link events for diagnostics (kinds and reasons only: no ids, names or addresses). */
  private readonly diag: string[] = [];
  /** Set right after a join: report if no teammate link comes up within this long. */
  watchFirstLinkMs = 0;

  private note(event: string): void {
    this.diag.push(`${Math.round((this.deps.now() % 600_000) / 1000)}s ${event}`);
    if (this.diag.length > 16) this.diag.shift();
    addBreadcrumb(`team link: ${event}`);
  }

  /**
   * The joiner flake seen once on the simulator (admitted, then the team
   * session never linked up): if no session opens within `watchFirstLinkMs`
   * of the first mesh start after a join, report it with the link's recent
   * events — kinds and reasons only, nothing personal.
   */
  private armFirstLinkWatch(): void {
    const ms = this.watchFirstLinkMs;
    this.watchFirstLinkMs = 0;
    setTimeout(() => {
      const status = this.meshStatus();
      if (status === null) return; // stopped meanwhile (backgrounded): not this case
      if (this.peers().some((p) => p.phase === 'open')) return;
      reportError(
        new Error(
          `Team: no teammate link ${Math.round(ms / 1000)} s after joining ` +
            `(discovered ${status.discovered}, dials ${this.deps.net?.manualDials().length ?? 0}, ` +
            `local network ${status.localNetwork}; ${this.diag.join(' | ')})`,
        ),
        'team-join-reconnect',
      );
    }, ms);
  }

  // ── Mesh ─────────────────────────────────────────────────────────────────

  /** Sync on (foreground or recording): the host's LAN advertises this team. */
  async startMesh(): Promise<void> {
    const net = this.deps.net;
    if (net === null || net.running(this.teamId)) return;
    this.note('mesh started');
    const started = net.start(this.teamId);
    if (this.watchFirstLinkMs > 0) this.armFirstLinkWatch();
    await started;
    this.changed();
  }

  async stopMesh(): Promise<void> {
    await this.deps.net?.stop(this.teamId);
    this.meta.clear();
    this.changed();
  }

  /** Hotspot fallback: dial a typed address (retries until the mesh stops). */
  dial(host: string, port: number): boolean {
    return this.deps.net?.dial(this.teamId, host, port) ?? false;
  }

  /** Run the periodic sync now (tests, and after returning to the foreground). */
  tick(): void {
    this.deps.net?.tick();
  }

  // ── The link layer's view of this group (`GroupEndpoint`) ───────────────

  /** Session options this team adds: live strokes only on the LAN (first party, #683). */
  sessionOptions(path: PathKind): Partial<SessionOptions> {
    return path === 'nearby'
      ? { carryLiveStrokes: true, liveStrokeMute: this.liveStrokeMute }
      : { liveStrokeMute: this.liveStrokeMute };
  }

  /** A session of this team started on a connection. */
  attached(connKey: string): void {
    const now = this.deps.now();
    const prev = this.meta.get(connKey);
    this.meta.set(connKey, {
      connectedAt: prev?.connectedAt ?? now,
      lastFrameAt: now,
      joining: prev?.joining ?? false,
    });
  }

  decode(op: SignedOp): Json | undefined {
    return this.replica.decode(op);
  }

  /** One of this team's sessions changed (the host's links route it here). */
  onSessionEvent(peerId: string, event: SessionEvent, session: SyncSession): void {
    const meta = this.meta.get(peerId);
    if (meta) meta.lastFrameAt = this.deps.now();
    switch (event.type) {
      case 'open': {
        this.note(event.joining ? 'open (joiner)' : 'open');
        if (!event.joining) this.peersSeen.add(event.peer);
        if (meta) meta.joining = event.joining;
        if (event.joining && session.safetyCode !== undefined) {
          // The core admits during the handshake, so 'admitted' may come first.
          this.joinNotices.unshift({
            peerId,
            code: session.safetyCode,
            at: this.deps.now(),
            memberId: this.admittedOn.get(peerId) ?? null,
          });
          this.joinNotices.splice(5);
        }
        this.changed();
        return;
      }
      case 'ingested':
        // Persisted by the store already; relay to everyone else.
        this.afterStored(event.report.accepted, peerId);
        return;
      case 'admitted': {
        this.admittedOn.set(peerId, event.member);
        const notice = this.joinNotices.find((n) => n.peerId === peerId);
        if (notice) notice.memberId = event.member;
        this.gossip([event.op], peerId);
        this.changed();
        return;
      }
      case 'closed': {
        this.note(`closed ${event.why.slice(0, 40)}`);
        this.meta.delete(peerId);
        this.admittedOn.delete(peerId);
        // A join attempt that ended without an admission: its code is moot.
        const i = this.joinNotices.findIndex((n) => n.peerId === peerId && n.memberId === null);
        if (i >= 0) this.joinNotices.splice(i, 1);
        this.changed();
        return;
      }
      default:
        return;
    }
  }

  private gossip(ops: readonly SignedOp[], except: string | null): void {
    if (ops.length === 0) return;
    this.deps.net?.push(this.teamId, ops, except);
  }

  /** The screens show this team (alerts and receipts are for it). */
  private get foreground(): boolean {
    return this.deps.foreground?.() ?? true;
  }

  private afterStored(ops: readonly SignedOp[], from: string | null): void {
    if (ops.length === 0) return;
    if (
      from !== null &&
      this.foreground &&
      ops.some((op) => op.env.t === 'pen' || op.env.t === 'e.set')
    ) {
      for (const a of this.draw.admit(ops)) this.deps.onDrawAlert?.(a);
    }
    if (onlyPens(ops)) {
      // Live strokes: relayed, and drawn by the drawing layer alone (#683).
      this.gossip(ops, from);
      this.deps.onDraw?.();
      return;
    }
    this.dirty = true;
    this.gossip(ops, from);
    if (ops.some((op) => op.env.t === 'pen' || op.env.t === 'e.set')) this.deps.onDraw?.();
    const foreground = this.foreground;
    // A team not on screen still rings for an SOS (an `e.set`); nothing else.
    const sosOnly = !foreground;
    let rang = false;
    if (
      from !== null &&
      ops.some((op) => op.env.t === 'e.set' || (foreground && op.env.t === 'msg'))
    ) {
      const now = this.deps.now();
      // The data first: reading it folds anything the replica deferred (an
      // out-of-order batch soon after a refold), which replaces its state. A
      // state read before it lacked the new ops, so an SOS arriving that way
      // was "not applied" and never alerted (#752).
      const data = this.replica.data(now);
      const ctx = alertContext(this.replica.state, data);
      const sosOpen = (entity: string) => {
        const [, owner, id] = entity.split(':');
        const sos = owner && id ? ctx.sos?.(owner, id) : undefined;
        return sos !== undefined && !sos.resolved;
      };
      for (const op of ops) {
        if (sosOnly && op.env.t !== 'e.set') continue;
        const alert = alertFor(this.replica.state, op, this.replica.decode(op), this.me, ctx);
        if (!alert || (sosOnly && alert.kind !== 'sos')) continue;
        rang = true;
        this.deps.onAlert(this.taskThrottle.admit(alert, now, sosOpen));
      }
    }
    // A teammate's SOS or rally point just synced: say so (#708). Not on
    // screen: only for the SOS that rang here.
    if (from !== null && ops.some((op) => op.env.t === 'e.set')) {
      if (foreground) this.sendOwedReceipts();
      else if (rang) this.sendOwedReceipts({ sosOnly: true });
    }
    this.changed();
    // A new key (a rotation, or our first key after a join): re-post what the
    // members admitted later can't read otherwise.
    if (ops.some((op) => op.env.t === 'k.rotate' || op.env.t === 'm.admit')) {
      this.republishIfNewKey();
    }
  }

  private changed(): void {
    this.dirty = true;
    this.checkProvisional();
    this.deps.onChange();
  }

  /** Members this phone completed a session with (R-INV-4 confirmation). */
  private readonly peersSeen = new Set<string>();

  /** Joined over the internet and not vouched for yet (R-INV-4). */
  get provisional(): boolean {
    return this.record.provisional !== undefined;
  }

  /** A second member, or another admin's later op, vouches for the log: no longer provisional. */
  private checkProvisional(): void {
    const join = this.record.provisional;
    if (join === undefined) return;
    if (!joinConfirmed(this.replica.state, join, this.peersSeen)) return;
    const { provisional: _done, ...rest } = this.record;
    this.record = rest;
    this.onRecordChange?.(this.record);
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  private guardWrite(): ActionError | null {
    const view = this.view();
    if (!view.active) return 'not-member';
    if (view.readOnly) return 'read-only';
    return null;
  }

  /** Run a local mutation through the persisting store; the store gossips it. */
  private run<T>(fn: () => T, ephemeral?: (r: T) => SignedOp | undefined): T {
    return this.store.track(() => {
      const result = fn();
      const op = ephemeral?.(result);
      return { result, accepted: op ? [op] : [] };
    }).result;
  }

  private writeMsg(
    body: Json,
    options: { aud?: Audience; pr?: Priority } = {},
  ): ActionError | null {
    const op = this.run(() => this.replica.write(this.deps.now(), 'msg', body, options));
    return op === undefined ? 'rotation-pending' : null;
  }

  sendMessage(
    text: string,
    options: { aud?: Audience; pr?: Priority; mentions?: string[]; id?: string } = {},
  ): ActionError | null {
    const blocked = this.guardWrite();
    if (blocked) return blocked;
    const tx = text.trim();
    if (tx.length === 0) return 'invalid';
    if (tx.length > 4000) return 'too-large';
    const self = this.replica.state.members.get(this.me);
    if (options.pr === 2 && !(self && (self.role === 'admin' || self.role === 'owner'))) {
      // The core lets group leads send urgent to their subtree too; v1's UI
      // offers urgent to admins only (simpler to explain).
      return 'not-allowed';
    }
    const body: Record<string, Json> = { id: options.id ?? this.deps.newId(), th: TEAM_THREAD, tx };
    if (options.mentions && options.mentions.length > 0) body['mn'] = options.mentions;
    const extra: { aud?: Audience; pr?: Priority } = {};
    if (options.aud) extra.aud = options.aud;
    if (options.pr) extra.pr = options.pr;
    const err = this.writeMsg(body, extra);
    if (err === null) this.markRead();
    return err;
  }

  /** My display name in this team (re-posted as `sys:profile`). */
  setMyName(raw: string): ActionError | null {
    const name = cleanName(raw);
    if (name === null) return 'invalid';
    const err = this.writeMsg(systemMessage(this.deps.newId(), SYS_PROFILE, nameText(name)));
    if (err !== null) return err;
    this.updateRecord({ myName: name, profileKeyId: this.replica.state.sendKeyId });
    return null;
  }

  /**
   * After a new team key: re-post my name (and, for admins, the team's name)
   * under it, so members admitted after the rotation can read them.
   */
  republishIfNewKey(): void {
    if (this.profileCheckBusy) return;
    const keyId = this.replica.state.sendKeyId;
    const view = this.view();
    if (keyId === undefined || !view.active || view.readOnly) return;
    this.profileCheckBusy = true;
    try {
      if (this.record.profileKeyId !== keyId && this.record.myName) {
        const ok = this.writeMsg(
          systemMessage(this.deps.newId(), SYS_PROFILE, nameText(this.record.myName)),
        );
        if (ok === null) this.updateRecord({ profileKeyId: keyId });
      }
      if (view.isAdmin && this.record.teamNameKeyId !== keyId) {
        const ok = this.writeMsg(systemMessage(this.deps.newId(), SYS_TEAM, nameText(view.name)));
        if (ok === null) this.updateRecord({ teamNameKeyId: keyId });
      }
      // Tell the team this phone draws live (#683) and sends receipts (#708):
      // once, under a key it can use.
      this.draw.advertise();
      this.sendOwedReceipts();
    } finally {
      this.profileCheckBusy = false;
    }
  }

  sharePosition(fix: {
    latitude: number;
    longitude: number;
    accuracy?: number | null;
    altitude?: number | null;
    at: number;
  }): ActionError | null {
    const blocked = this.guardWrite();
    if (blocked) return blocked;
    if (!this.record.prefs.sharePosition) return 'not-allowed';
    // Provisional (R-INV-4): the admitting phone may be a removed member's.
    if (this.provisional) return null;
    const pos: Record<string, Json> = {
      la: Math.round(fix.latitude * 1e6) / 1e6,
      lo: Math.round(fix.longitude * 1e6) / 1e6,
      at: Math.floor(fix.at),
    };
    if (typeof fix.accuracy === 'number' && Number.isFinite(fix.accuracy) && fix.accuracy >= 0) {
      pos['ac'] = Math.round(fix.accuracy);
    }
    if (typeof fix.altitude === 'number' && Number.isFinite(fix.altitude)) {
      pos['el'] = Math.round(fix.altitude);
    }
    const op = this.run(
      () => this.replica.position(this.deps.now(), pos, POSITION_TTL_S),
      (r) => r,
    );
    return op === undefined ? 'rotation-pending' : null;
  }

  private canEditShared(): boolean {
    const role = this.replica.state.members.get(this.me)?.role;
    return role !== undefined && role !== 'guest';
  }

  shareWaypoint(w: ShareableWaypoint): ActionError | null {
    const blocked = this.guardWrite();
    if (blocked) return blocked;
    if (!this.canEditShared()) return 'not-allowed';
    const id = this.deps.newId();
    const op = this.run(() =>
      this.replica.write(this.deps.now(), 'e.set', {
        k: 'wpt',
        id,
        f: waypointFields(w, this.me, this.deps.now()),
      }),
    );
    return op === undefined ? 'rotation-pending' : null;
  }

  deleteWaypoint(id: string): ActionError | null {
    const blocked = this.guardWrite();
    if (blocked) return blocked;
    if (!this.canEditShared()) return 'not-allowed';
    const op = this.run(() => this.replica.write(this.deps.now(), 'e.del', { k: 'wpt', id }));
    return op === undefined ? 'rotation-pending' : null;
  }

  /** Share a recorded trail; `id` = its Library id, so a re-share updates the same record. */
  shareTrack(t: ShareableTrack, id: string = this.deps.newId()): ActionError | null {
    const blocked = this.guardWrite();
    if (blocked) return blocked;
    if (!this.canEditShared()) return 'not-allowed';
    const f = trackFields(t);
    if (f === null) return 'too-large';
    const op = this.run(() => this.replica.write(this.deps.now(), 'e.set', { k: 'track', id, f }));
    return op === undefined ? 'rotation-pending' : null;
  }

  deleteTrack(id: string, owner: string): ActionError | null {
    const blocked = this.guardWrite();
    if (blocked) return blocked;
    const op = this.run(() =>
      this.replica.write(this.deps.now(), 'e.del', { k: 'track', id, o: owner }),
    );
    return op === undefined ? 'rotation-pending' : null;
  }

  /** Comment on a whole shared trail (a message on its `trail:` thread; guests too). */
  commentOnTrail(
    trackId: string,
    text: string,
    mentions: string[] = [],
    id: string = this.deps.newId(),
  ): ActionError | null {
    const blocked = this.guardWrite();
    if (blocked) return blocked;
    const tx = text.trim();
    if (tx.length === 0 || tx.length > 4000) return 'invalid';
    const body: Record<string, Json> = { id, th: trailThread(trackId), tx };
    if (mentions.length > 0) body['mn'] = mentions;
    return this.writeMsg(body);
  }

  /** Comment on a shared photo (the core's owned `comment` entity, `PhotoComment`; guests too). */
  commentOnPhoto(
    photoId: string,
    text: string,
    mentions: string[] = [],
    id: string = this.deps.newId(),
  ): ActionError | null {
    const blocked = this.guardWrite();
    if (blocked) return blocked;
    const tx = text.trim();
    if (tx.length === 0 || tx.length > 4000) return 'invalid';
    const f: Record<string, Json> = { photoId, text: tx };
    if (mentions.length > 0) f['mentions'] = mentions;
    const op = this.run(() =>
      this.replica.write(this.deps.now(), 'e.set', { k: 'comment', id, f }),
    );
    if (op !== undefined) this.markSeen(`photo:${photoId}`);
    return op === undefined ? 'rotation-pending' : null;
  }

  /** Pin a message to a place (guests too); `id` is the pin's id. */
  dropPin(
    lng: number,
    lat: number,
    text: string,
    mentions: string[] = [],
    id: string = this.deps.newId(),
  ): ActionError | null {
    const blocked = this.guardWrite();
    if (blocked) return blocked;
    const tx = text.trim();
    if (tx.length === 0 || tx.length > 4000) return 'invalid';
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90)
      return 'invalid';
    const body: Record<string, Json> = { id, th: pinThread(this.me, id), tx, ll: [lng, lat] };
    if (mentions.length > 0) body['mn'] = mentions;
    const err = this.writeMsg(body);
    if (err === null) this.markSeen(pinThread(this.me, id));
    return err;
  }

  /** Reply under a pin (guests too). */
  replyToPin(
    pinOwner: string,
    pinId: string,
    text: string,
    mentions: string[] = [],
    id: string = this.deps.newId(),
  ): ActionError | null {
    const blocked = this.guardWrite();
    if (blocked) return blocked;
    const tx = text.trim();
    if (tx.length === 0 || tx.length > 4000) return 'invalid';
    const body: Record<string, Json> = { id, th: pinThread(pinOwner, pinId), tx };
    if (mentions.length > 0) body['mn'] = mentions;
    const err = this.writeMsg(body);
    if (err === null) this.markSeen(pinThread(pinOwner, pinId));
    return err;
  }

  /** Create a task (members and up). */
  createTask(t: NewTask): ActionError | null {
    const blocked = this.guardWrite();
    if (blocked) return blocked;
    if (!this.canEditShared()) return 'not-allowed';
    const f = taskFields(t);
    if (!validTaskFields(f, this.me)) return 'invalid';
    const notes = cleanTaskNotes(t.notes ?? '');
    const id = this.deps.newId();
    const op = this.run(() => this.replica.write(this.deps.now(), 'e.set', { k: 'task', id, f }));
    if (op === undefined) return 'rotation-pending';
    // The notes in their own write: a 2.6.x phone skips it and still shows the task.
    if (notes === '') return null;
    const n = this.run(() =>
      this.replica.write(this.deps.now(), 'e.set', { k: 'task', id, f: taskNotesFields(notes) }),
    );
    return n === undefined ? 'rotation-pending' : null;
  }

  /**
   * Edit a task (#746): its creator or an admin. Only what changed is
   * written, in the writes `taskEditWrites` lays out (what every version
   * reads first, then "no place" and the notes, each on its own).
   */
  updateTask(owner: string, id: string, edit: TaskEdit): ActionError | null {
    const blocked = this.guardWrite();
    if (blocked) return blocked;
    const task = this.tasks().find((x) => x.owner === owner && x.id === id);
    if (task === undefined) return 'invalid';
    if (!canEditTask(task, this.me, this.myRole)) return 'not-allowed';
    const writes = taskEditWrites(task, edit);
    if (writes.length === 0) return null;
    if (!writes.every((f) => validTaskFields(f, this.me))) return 'invalid';
    for (const f of writes) {
      const body: Record<string, Json> = { k: 'task', id, f };
      if (owner !== this.me) body['o'] = owner;
      const op = this.run(() => this.replica.write(this.deps.now(), 'e.set', body));
      if (op === undefined) return 'rotation-pending';
      if (!this.applied(op.id)) return 'not-allowed';
    }
    return null;
  }

  /** Mark a task done (or open again): its creator, its assignee or an admin. */
  setTaskDone(owner: string, id: string, done: boolean): ActionError | null {
    const blocked = this.guardWrite();
    if (blocked) return blocked;
    if (!this.canEditShared()) return 'not-allowed';
    const body: Record<string, Json> = {
      k: 'task',
      id,
      f: statusFields(done, this.me, this.deps.now()),
    };
    if (owner !== this.me) body['o'] = owner;
    const op = this.run(() => this.replica.write(this.deps.now(), 'e.set', body));
    return op === undefined ? 'rotation-pending' : null;
  }

  /** Delete a task: its creator or an admin. */
  deleteTask(owner: string, id: string): ActionError | null {
    const blocked = this.guardWrite();
    if (blocked) return blocked;
    const op = this.run(() =>
      this.replica.write(this.deps.now(), 'e.del', { k: 'task', id, o: owner }),
    );
    return op === undefined ? 'rotation-pending' : null;
  }

  /** Raw entity write for shares built elsewhere (trail photos and their thumbnails). */
  writeEntity(kind: 'photo', id: string, fields: Record<string, Json>): ActionError | null {
    const blocked = this.guardWrite();
    if (blocked) return blocked;
    if (!this.canEditShared()) return 'not-allowed';
    const op = this.run(() =>
      this.replica.write(this.deps.now(), 'e.set', { k: kind, id, f: fields }),
    );
    return op === undefined ? 'rotation-pending' : null;
  }

  // ── Admin actions ────────────────────────────────────────────────────────

  private control(t: Parameters<TeamReplica['control']>[1], b: Json, secret?: Json): string {
    const op = this.run(() => this.replica.control(this.deps.now(), t, b, secret));
    return op.id;
  }

  /** Did the fold accept the op we just wrote? */
  private accepted(opId: string): boolean {
    return !this.replica.state.rejected.has(opId);
  }

  /**
   * Did the data op we just wrote take effect? The membership fold can accept
   * it (signed by a member) while the data fold skips it (a record rule:
   * forbidden or invalid); `accepted` alone called such a write a success,
   * so a refused SOS was reported as sent (QA 2.6.1).
   */
  private applied(opId: string): boolean {
    if (!this.accepted(opId)) return false;
    return !this.replica.data(this.deps.now()).skipped.some((s) => s.id === opId);
  }

  setRole(memberId: string, role: Role): ActionError | null {
    const blocked = this.guardWrite();
    if (blocked) return blocked;
    const target = this.replica.state.members.get(memberId);
    if (target === undefined || target.status !== 'active') return 'invalid';
    if (target.role === role) return 'no-change';
    const b: Record<string, Json> = { m: memberId, r: role };
    // Demoting an admin pins their chain (spec §6 cuts); always via cutFor.
    if (target.role === 'admin' && role !== 'admin')
      b['cut'] = cutFor(this.replica.state, memberId);
    if (role === 'admin') b['from'] = this.replica.state.chains.get(memberId)?.ids.length ?? 0;
    return this.accepted(this.control('m.update', b)) ? null : 'not-allowed';
  }

  /** Remove a member, then rotate the team key at once (removal fails closed). */
  removeMember(memberId: string): ActionError | null {
    const blocked = this.guardWrite();
    if (blocked) return blocked;
    const id = this.control('m.remove', { m: memberId, cut: cutFor(this.replica.state, memberId) });
    if (!this.accepted(id)) return 'not-allowed';
    // R-INV-3: they may have seen an open invite; none of those works any more.
    const stale = invitesToRevoke(this.replica.state, this.deps.now());
    for (const inv of stale) this.control('i.revoke', { inv });
    if (stale.length > 0) {
      const who = this.view().members.find((m) => m.id === memberId)?.name ?? 'Someone';
      this.revokedNotice = { count: stale.length, name: who, at: this.deps.now() };
    }
    const err = this.rotateKey();
    // Their phone may still be connected: it got the removal; now hang up.
    this.deps.net?.closeMember(memberId, 'removed');
    return err;
  }

  rotateKey(): ActionError | null {
    const view = this.view();
    if (!view.isAdmin) return 'not-allowed';
    if (view.readOnly) return 'read-only';
    const { body } = rotateBody(this.deps.c, this.teamId, activeMembers(this.replica.state));
    const id = this.control('k.rotate', body);
    if (!this.accepted(id)) return 'not-allowed';
    this.republishIfNewKey();
    return null;
  }

  /** "+N days" (an expired team is revived; capped a year after the founding). */
  extend(days: number): ActionError | null {
    const view = this.view();
    if (!view.isAdmin) return 'not-allowed';
    if (view.closed) return 'read-only';
    const exp = extendedExpiry(view.expiresAt, days, this.deps.now(), view.maxExpiresAt);
    if (exp === null) return 'no-change';
    return this.accepted(this.control('t.extend', { exp })) ? null : 'not-allowed';
  }

  /** Whether the team syncs over the internet (its `net` switch; absent = off, design §6). */
  get internetOn(): boolean {
    return internetOn(this.replica.data(this.deps.now()));
  }

  /**
   * An admin turns the internet on or off for the whole team (#705, G7): the
   * group's `net` record, which every member's phone follows (rooms open only
   * for groups whose switch is on).
   */
  setInternet(on: boolean): ActionError | null {
    const blocked = this.guardWrite();
    if (blocked) return blocked;
    if (!this.view().isAdmin) return 'not-allowed';
    if (this.internetOn === on) return 'no-change';
    return this.writeOk({ k: NET, id: GROUP_RECORD_ID, f: { inet: on ? 1 : 0 } });
  }

  /** End the team for everyone (read-only from now on). */
  closeTeam(): ActionError | null {
    const blocked = this.guardWrite();
    if (blocked) return blocked;
    if (!this.view().isAdmin) return 'not-allowed';
    return this.accepted(this.control('t.close', {})) ? null : 'not-allowed';
  }

  createGroup(rawName: string, parent?: string): ActionError | null {
    const blocked = this.guardWrite();
    if (blocked) return blocked;
    const name = cleanName(rawName);
    if (name === null) return 'invalid';
    if (this.replica.sendKey() === undefined) return 'rotation-pending';
    const b: Record<string, Json> = { id: this.deps.newId() };
    if (parent !== undefined) b['p'] = parent;
    return this.accepted(this.control('g.set', b, { name })) ? null : 'not-allowed';
  }

  /** v1 UI: one group per member (the protocol allows 16), lead or not; null = none. */
  setMemberGroup(memberId: string, group: string | null, lead: boolean): ActionError | null {
    const blocked = this.guardWrite();
    if (blocked) return blocked;
    const g: GroupLink[] = group === null ? [] : [lead ? { g: group, lead: true } : { g: group }];
    const id = this.control('m.update', { m: memberId, g: g as unknown as Json });
    return this.accepted(id) ? null : 'not-allowed';
  }

  /**
   * An admin's invite: `i.create` in the log, the token to share. The QR
   * also carries this phone's LAN address (QR only, never SMS or links).
   */
  createInvite(choice: InviteChoice): CreatedInvite | ActionError {
    const blocked = this.guardWrite();
    if (blocked) return blocked;
    const view = this.view();
    if (!view.isAdmin) return 'not-allowed';
    const now = this.deps.now();
    const inv = createInvite(this.deps.c, this.teamId, {
      expiresAt: inviteExpiresAt(choice, now, view.expiresAt),
      maxUses: choice.uses,
      role: choice.role,
      approve: choice.approve,
    });
    if (!this.accepted(this.control('i.create', inv.body))) return 'not-allowed';
    // Its internet room (G7): members holding the key listen there for the joiner.
    const irdv = irdvFields(this.deps.c, inv.token);
    if (this.writeOk({ k: IRDV, id: irdv.id, f: irdv.f }) !== null) this.note('irdv not written');
    const net = this.netHint();
    const token: InviteToken = net ? { ...inv.token, net } : inv.token;
    return {
      token,
      payload: encodeInvite(token, 'link'),
      qrPayload: encodeInvite(token, 'qr'),
    };
  }

  /** This phone's private LAN address and listening port, for the QR's hint. */
  private netHint(): NetHint | undefined {
    const port = this.meshStatus()?.port;
    const info = this.deps.net?.networkInfo() ?? null;
    if (info === null || port == null) return undefined;
    try {
      for (const i of info.interfaces) {
        const v = parseIPv4(i.address);
        const host = ipv4Tuple(i.address);
        if (v !== null && host !== null && isPrivateIPv4(v)) return { host, port };
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  /** Invites a removal just cancelled (R-INV-3), for the admin's one banner; cleared by the screen. */
  revokedNotice: { count: number; name: string; at: number } | null = null;

  dismissRevokedNotice(): void {
    this.revokedNotice = null;
  }

  /** Tell the admins I deleted the team from this phone (they should remove me). */
  announceLeave(): void {
    if (this.guardWrite() !== null) return;
    this.writeMsg(systemMessage(this.deps.newId(), SYS_LEAVE, {}));
  }

  // ── Local prefs ──────────────────────────────────────────────────────────

  markRead(): void {
    const latest = this.view().messages.reduce((m, msg) => Math.max(m, msg.at), 0);
    if (latest > this.record.lastReadAt) this.updateRecord({ lastReadAt: latest });
  }

  /** When I last looked at a thread (`photo:<id>`, `pin:<id>`), epoch ms; 0 = never. */
  seenAt(thread: string): number {
    return this.record.seen?.[thread] ?? 0;
  }

  /** I looked at a thread now (kept to the 300 most recent threads). */
  markSeen(thread: string): void {
    const now = this.deps.now();
    if ((this.record.seen?.[thread] ?? 0) >= now) return;
    const entries = Object.entries({ ...this.record.seen, [thread]: now })
      .sort((a, b) => b[1] - a[1])
      .slice(0, 300);
    this.updateRecord({ seen: Object.fromEntries(entries) });
  }

  /** Local record changes (prefs, read marker): the service persists the index. */
  onRecordChange: ((record: TeamRecord) => void) | null = null;

  updateRecord(patch: Partial<TeamRecord>): void {
    this.record = { ...this.record, ...patch, prefs: { ...this.record.prefs, ...patch.prefs } };
    this.onRecordChange?.(this.record);
    this.changed();
  }
}
