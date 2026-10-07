/**
 * The team as the UI sees it (#589 UI): a plain, serialisable view built from
 * a resolved `TeamState`, the replica's data view and the labels of control
 * ops. Pure — the runtime (`@data/team/teamRuntime`) builds one after every
 * change and the Zustand store hands it to the screens.
 *
 * Nothing here decides validity: the fold already did. This only names,
 * sorts and filters what the fold accepted.
 */
import { isRecord, type Json } from '@core/team/canonical';
import { compareStamp, type Stamp } from '@core/team/hlc';
import type { SignedOp } from '@core/team/envelope';
import { visibleFields, isLive } from '@core/team/crdt';
import type { EntityRecord, TeamData } from '@core/team/data';
import {
  isReadOnly,
  MAX_TEAM_LIFETIME_MS,
  type MemberState,
  type TeamState,
} from '@core/team/membership';
import { audienceMembers, LARGE_TEAM } from '@core/team/notify';
import {
  canGrantRole,
  canManage,
  inAudience,
  isAdminRole,
  roleRank,
  type Audience,
  type Role,
} from '@core/team/roles';

import { initials, memberColor } from './colors';
import { parseNameText, SYS_LEAVE, SYS_PROFILE, SYS_TEAM } from './system';

/** The one chat thread of v1: the team channel (targeting is by audience). */
export const TEAM_THREAD = 'team';
/** The chat keeps the newest this many messages in the view. */
export const MAX_VIEW_MESSAGES = 500;

export interface MemberGroup {
  id: string;
  name: string;
  lead: boolean;
}

export interface MemberRow {
  id: string;
  name: string;
  /** False while we only know the member id (no profile message yet). */
  named: boolean;
  initials: string;
  color: string;
  role: Role;
  active: boolean;
  isMe: boolean;
  groups: MemberGroup[];
  joinedAt: number;
  via: MemberState['via'];
  /** Posted "I left" (`sys:leave`) while still a member: an admin should remove them. */
  left: boolean;
  /** Newest thing we hold from them (op wall clock, ms), or null. */
  lastSeenAt: number | null;
  /** What I may do to them (admins and the owner only). */
  actions: MemberActions;
}

export interface MemberActions {
  promote: Role | null;
  demote: Role | null;
  remove: boolean;
  setGroup: boolean;
}

export interface GroupRow {
  id: string;
  name: string;
  parent: string | null;
  depth: number;
  members: number;
}

export interface ChatMessage {
  /** Entity key (unique per author). */
  key: string;
  author: string;
  authorName: string;
  authorColor: string;
  text: string;
  at: number;
  stamp: Stamp;
  mine: boolean;
  priority: 0 | 1 | 2;
  /** "Admins", "Trail crew leads"… null = the whole team. */
  audience: string | null;
  mentionsMe: boolean;
}

export interface TeamView {
  teamId: string;
  name: string;
  /** When the team was founded (genesis wall clock). */
  createdAt: number;
  /** The latest expiry an extension may set (genesis + 365 days). */
  maxExpiresAt: number;
  expiresAt: number;
  readOnly: boolean;
  closed: boolean;
  me: string;
  myRole: Role | null;
  /** I am still an active member (false once removed). */
  active: boolean;
  isAdmin: boolean;
  /** A join raced; an admin should rotate the key (shown to everyone). */
  rotationAdvised: boolean;
  /** No safe key to write with until an admin rotates (after a removal). */
  needsRotation: boolean;
  members: MemberRow[];
  groups: GroupRow[];
  messages: ChatMessage[];
  activeCount: number;
}

export interface ViewInput {
  state: TeamState;
  data: TeamData;
  me: string;
  now: number;
  /** The decrypted labels of a control op (team and group names), if we hold its key. */
  labels: (op: SignedOp) => Json | undefined;
}

/** Shown until a member's profile arrives: stable, short, and obviously a placeholder. */
export function placeholderName(memberId: string): string {
  return `Teammate ${memberId.slice(0, 4)}`;
}

const nameOf = (labels: Json | undefined): string | null =>
  isRecord(labels) && typeof labels['name'] === 'string' ? labels['name'].trim() || null : null;

/** Newest message per author on one `sys:` thread, as `[author, rec]`. */
function newestSystem(data: TeamData, thread: string): Map<string, EntityRecord> {
  const out = new Map<string, EntityRecord>();
  for (const rec of data.entities.values()) {
    if (rec.kind !== 'msg' || rec.owner === undefined || rec.state.created === undefined) continue;
    if (visibleFields(rec.state)['th'] !== thread || !isLive(rec.state)) continue;
    const prev = out.get(rec.owner);
    if (prev === undefined || compareStamp(rec.state.created, prev.state.created!) > 0) {
      out.set(rec.owner, rec);
    }
  }
  return out;
}

export function profileNames(data: TeamData): Map<string, string> {
  const out = new Map<string, string>();
  for (const [author, rec] of newestSystem(data, SYS_PROFILE)) {
    const name = parseNameText(visibleFields(rec.state)['tx']);
    if (name !== null) out.set(author, name);
  }
  return out;
}

/** Genesis labels when we hold key 0; else the newest `sys:team` from an admin. */
export function teamName(state: TeamState, data: TeamData, labels: ViewInput['labels']): string {
  const fromGenesis = state.genesis ? nameOf(labels(state.genesis)) : null;
  if (fromGenesis !== null) return fromGenesis;
  let best: { name: string; stamp: Stamp } | null = null;
  for (const [author, rec] of newestSystem(data, SYS_TEAM)) {
    const m = state.members.get(author);
    if (m === undefined || !isAdminRole(m.role)) continue;
    const name = parseNameText(visibleFields(rec.state)['tx']);
    if (name !== null && (best === null || compareStamp(rec.state.created!, best.stamp) > 0)) {
      best = { name, stamp: rec.state.created! };
    }
  }
  return best?.name ?? 'Team';
}

/** Group names from the newest `g.set` labels for each id. */
function groupNames(state: TeamState, labels: ViewInput['labels']): Map<string, string> {
  const out = new Map<string, string>();
  for (const op of state.control) {
    if (op.env.t !== 'g.set' || !isRecord(op.env.b)) continue;
    const id = op.env.b['id'];
    const name = nameOf(labels(op));
    if (typeof id === 'string' && name !== null) out.set(id, name);
  }
  return out;
}

export function groupRows(state: TeamState, labels: ViewInput['labels']): GroupRow[] {
  const names = groupNames(state, labels);
  const counts = new Map<string, number>();
  for (const m of state.members.values()) {
    if (m.status !== 'active') continue;
    for (const link of m.groups) counts.set(link.g, (counts.get(link.g) ?? 0) + 1);
  }
  const children = new Map<string | null, string[]>();
  for (const [id, parent] of state.groups) {
    const key = parent ?? null;
    children.set(key, [...(children.get(key) ?? []), id]);
  }
  const label = (id: string) => names.get(id) ?? 'Group';
  const out: GroupRow[] = [];
  // Depth-first, siblings by name: the tree reads top-down like an org chart.
  const walk = (parent: string | null, depth: number) => {
    const kids = [...(children.get(parent) ?? [])].sort((a, b) => label(a).localeCompare(label(b)));
    for (const id of kids) {
      out.push({ id, name: label(id), parent, depth, members: counts.get(id) ?? 0 });
      if (depth < 16) walk(id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** What `actor` may do to `target`, by the core's authority rules (`roles.ts`, `membership.ts`). */
export function memberActions(
  actor: MemberState | undefined,
  target: MemberState,
  groupsExist: boolean,
): MemberActions {
  const none: MemberActions = { promote: null, demote: null, remove: false, setGroup: false };
  if (actor === undefined || actor.status !== 'active' || target.status !== 'active') return none;
  if (actor.id === target.id || !canManage(actor.role, target.role)) return none;
  const up: Role | null =
    target.role === 'guest' ? 'member' : target.role === 'member' ? 'admin' : null;
  const down: Role | null =
    target.role === 'admin' ? 'member' : target.role === 'member' ? 'guest' : null;
  // v1: a demoted admin is never re-promoted (they rejoin with a new device).
  const promote =
    up !== null &&
    canGrantRole(actor.role, up) &&
    !(up === 'admin' && target.adminCut !== undefined)
      ? up
      : null;
  const demote = down !== null && canGrantRole(actor.role, down) ? down : null;
  return { promote, demote, remove: true, setGroup: groupsExist };
}

/** "Admins", "Trail crew", "Trail crew leads", "Julie, Ana"… */
export function audienceLabel(
  aud: Audience | undefined,
  groupName: (id: string) => string,
  memberName: (id: string) => string,
): string | null {
  if (aud === undefined) return null;
  const parts: string[] = [];
  if (aud.r !== undefined) {
    const admins = aud.r.includes('admin') || aud.r.includes('owner');
    if (admins) parts.push('Admins');
    for (const r of aud.r) {
      if (r === 'member') parts.push('Members');
      if (r === 'guest') parts.push('Guests');
    }
  }
  if (aud.g !== undefined) {
    for (const g of aud.g) parts.push(aud.l ? `${groupName(g)} leads` : groupName(g));
  } else if (aud.l) {
    parts.push('Group leads');
  }
  if (aud.m !== undefined) for (const m of aud.m) parts.push(memberName(m));
  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * The delivery `routeDelivery` (`@core/team/notify`) gives a group-mode team
 * message, from its record: urgent, mention → alert; important → badge (alert
 * from an admin); normal → badge in a small or narrowly targeted team, from
 * an admin or a lead of one of my groups; else silent. `none` when it isn't
 * for me. Sealed DMs are not part of v1's UI.
 */
export function messageDelivery(
  state: TeamState,
  rec: Pick<EntityRecord, 'owner' | 'aud' | 'pr'> & { mentions: readonly string[] },
  me: string,
): 'none' | 'silent' | 'badge' | 'alert' {
  const self = state.members.get(me);
  if (rec.owner === me || self === undefined || self.status !== 'active') return 'none';
  if (!inAudience(rec.aud, self, state.groups)) return 'none';
  const sender = rec.owner === undefined ? undefined : state.members.get(rec.owner);
  const senderIsAdmin = sender !== undefined && isAdminRole(sender.role);
  if (rec.pr === 2) return 'alert';
  if (rec.mentions.includes(me)) return 'alert';
  if (rec.pr === 1) return senderIsAdmin ? 'alert' : 'badge';
  const narrow = audienceMembers(state, rec.aud).length <= LARGE_TEAM;
  const myLead =
    sender !== undefined &&
    sender.groups.some((l) => l.lead === true && self.groups.some((mine) => mine.g === l.g));
  return narrow || senderIsAdmin || myLead ? 'badge' : 'silent';
}

const mentionsOf = (fields: Record<string, Json>): string[] =>
  Array.isArray(fields['mn']) ? fields['mn'].filter((m): m is string => typeof m === 'string') : [];

export function buildTeamView(input: ViewInput): TeamView {
  const { state, data, me, now, labels } = input;
  const profiles = profileNames(data);
  const left = newestSystem(data, SYS_LEAVE);
  const gNames = groupNames(state, labels);
  const self = state.members.get(me);

  // Last seen: the newest op wall clock per author (logged ops and positions).
  const lastSeen = new Map<string, number>();
  const seen = (author: string, wall: number) =>
    lastSeen.set(author, Math.max(lastSeen.get(author) ?? 0, wall));
  for (const op of state.control) seen(op.env.au, op.stamp.wall);
  for (const op of state.data) seen(op.env.au, op.stamp.wall);
  for (const [author, reg] of data.positions) seen(author, reg.stamp.wall);

  const joinOrder = [...state.members.values()].sort(
    (a, b) => compareStamp(a.joinedAt, b.joinedAt) || (a.id < b.id ? -1 : 1),
  );
  const colorIndex = new Map(joinOrder.map((m, i) => [m.id, i]));
  const nameFor = (id: string) => profiles.get(id) ?? placeholderName(id);

  const members: MemberRow[] = joinOrder.map((m) => {
    const name = nameFor(m.id);
    const leftRec = left.get(m.id);
    return {
      id: m.id,
      name,
      named: profiles.has(m.id),
      initials: initials(name),
      color: memberColor(colorIndex.get(m.id) ?? 0),
      role: m.role,
      active: m.status === 'active',
      isMe: m.id === me,
      groups: m.groups
        .filter((l) => state.groups.has(l.g))
        .map((l) => ({ id: l.g, name: gNames.get(l.g) ?? 'Group', lead: l.lead === true })),
      joinedAt: m.joinedAt.wall,
      via: m.via,
      left: leftRec !== undefined && m.status === 'active',
      lastSeenAt: lastSeen.get(m.id) ?? null,
      actions: memberActions(self, m, state.groups.size > 0),
    };
  });
  // Me first, then by role (owner → guest), then by name; removed members last.
  members.sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      Number(b.isMe) - Number(a.isMe) ||
      roleRank(b.role) - roleRank(a.role) ||
      a.name.localeCompare(b.name),
  );

  const messages: ChatMessage[] = [];
  for (const rec of data.entities.values()) {
    if (rec.kind !== 'msg' || rec.owner === undefined || rec.state.created === undefined) continue;
    if (!isLive(rec.state)) continue;
    const f = visibleFields(rec.state);
    const th = f['th'];
    const tx = f['tx'];
    if (th !== TEAM_THREAD || typeof tx !== 'string') continue;
    const mine = rec.owner === me;
    if (!mine && self !== undefined && !inAudience(rec.aud, self, state.groups)) continue;
    const mentions = mentionsOf(f);
    messages.push({
      key: `${rec.owner}:${rec.id}`,
      author: rec.owner,
      authorName: nameFor(rec.owner),
      authorColor: memberColor(colorIndex.get(rec.owner) ?? 0),
      text: tx,
      at: rec.state.created.wall,
      stamp: rec.state.created,
      mine,
      priority: rec.pr ?? 0,
      audience: audienceLabel(rec.aud, (g) => gNames.get(g) ?? 'Group', nameFor),
      mentionsMe: mentions.includes(me),
    });
  }
  messages.sort((a, b) => compareStamp(a.stamp, b.stamp));
  if (messages.length > MAX_VIEW_MESSAGES) messages.splice(0, messages.length - MAX_VIEW_MESSAGES);

  const myRole = self?.role ?? null;
  return {
    teamId: state.teamId,
    name: teamName(state, data, labels),
    expiresAt: state.expiresAt,
    createdAt: state.genesis?.stamp.wall ?? 0,
    maxExpiresAt: (state.genesis?.stamp.wall ?? 0) + MAX_TEAM_LIFETIME_MS,
    readOnly: isReadOnly(state, now),
    closed: state.closedAt !== undefined,
    me,
    myRole,
    active: self?.status === 'active',
    isAdmin: self?.status === 'active' && isAdminRole(self.role),
    rotationAdvised: state.rotationAdvised,
    needsRotation: state.needsRotation,
    members,
    groups: groupRows(state, labels),
    messages,
    activeCount: members.filter((m) => m.active).length,
  };
}
