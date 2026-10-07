/**
 * What the app does when a teammate's op arrives (#589 UI). The routing is
 * the core's (`routeDelivery`, spec §9): `alert` buzzes and notifies,
 * `badge` only counts as unread, `silent` and `none` do nothing. Ordinary
 * chatter in a team of more than 30 people stays silent unless it comes
 * from an admin or a lead of one of my groups ("buzz above 30 members").
 *
 * On top of the core's rules, for the UI:
 * - `sys:` threads (`./system`) never notify;
 * - a comment on MY shared trail or photo alerts me (like a mention: it is
 *   addressed to me), whatever the team size; a comment that mentions me too;
 *   other photo comments follow the normal-message rule;
 * - a reply on MY pin alerts me (a new pin follows the normal-message rule);
 * - a task assigned to me alerts me; my task marked done by someone else
 *   alerts me;
 * - every alert carries where tapping it goes (`url`). Pure.
 */
import type { Json } from '@core/team/canonical';
import { isRecord } from '@core/team/canonical';
import { isLive, visibleFields } from '@core/team/crdt';
import type { SignedOp } from '@core/team/envelope';
import type { TeamState } from '@core/team/membership';
import { audienceMembers, LARGE_TEAM, routeDelivery } from '@core/team/notify';
import { isAdminRole } from '@core/team/roles';

import type { TeamData } from '@core/team/data';
import { teamTasks } from '@core/team/tasks';

import { photoIndex, TRAIL_THREAD_PREFIX, trailOwners } from './comments';
import { parsePinThread, PIN_THREAD_PREFIX, teamPins } from './pins';
import { isSystemThread } from './system';
import { TEAM_THREAD } from './view';

export interface TeamAlert {
  /** `author:id` of the message or comment, for de-duplication. */
  key: string;
  author: string;
  level: 'badge' | 'alert';
  kind: 'message' | 'comment' | 'task' | 'sos';
  text: string;
  priority: 0 | 1 | 2;
  /** The route tapping it opens. */
  url: string;
}

/** What alert routing needs to know about shared trails and photos (from the data view). */
export interface AlertContext {
  /**
   * Whether the data fold APPLIED this op (accepted, not skipped as forbidden
   * or invalid). Nothing alerts on an op the fold refused (review #1).
   */
  applied(opId: string): boolean;
  photo(photoId: string): { owner: string; trackId: string } | undefined;
  trailOwner(trackId: string): string | undefined;
  /** Whether `owner`'s pin `id` exists. */
  hasPin(owner: string, id: string): boolean;
  /** A task as merged by the fold (validated fields), never the raw op. */
  /** An SOS as merged by the fold. */
  sos?(
    owner: string,
    id: string,
  ): { text: string; resolved: boolean; createdWall: number } | undefined;
  task(
    owner: string,
    id: string,
  ): { owner: string; title: string; assignee: string; done: boolean } | undefined;
}

/** The alert context of a resolved team and its data view (what the session uses). */
export function alertContext(state: TeamState, data: TeamData): AlertContext {
  const photos = photoIndex(data);
  const owners = trailOwners(data);
  const pins = new Set(teamPins(data).map((p) => `${p.owner}:${p.id}`));
  const tasks = new Map(teamTasks(data).map((t) => [`${t.owner}:${t.id}`, t]));
  const skipped = new Set(data.skipped.map((x) => x.id));
  return {
    // Applied = a data op the fold accepted (it has a role) and did not skip.
    applied: (id) => state.roleAt.has(id) && !skipped.has(id),
    photo: (id) => photos.get(id),
    trailOwner: (id) => owners.get(id),
    hasPin: (owner, id) => pins.has(`${owner}:${id}`),
    task: (owner, id) => tasks.get(`${owner}:${id}`),
    sos: (owner, id) => {
      const rec = data.entities.get(`sos:${owner}:${id}`);
      if (rec === undefined || !isLive(rec.state)) return undefined;
      const f = visibleFields(rec.state);
      return {
        text: typeof f['tx'] === 'string' ? f['tx'] : '',
        resolved: f['res'] === true,
        createdWall: rec.state.created?.wall ?? 0,
      };
    },
  };
}

/** Where a pin opens: the map, with its card. */
export function pinUrl(owner: string, id: string): string {
  return `/team/pin/${owner}/${id}`;
}

/** Alert texts are short: a long title is cut. */
const MAX_ALERT_TITLE = 120;
const cap = (s: string) => (s.length > MAX_ALERT_TITLE ? `${s.slice(0, MAX_ALERT_TITLE - 1)}…` : s);

export const TASKS_URL = '/team/tasks';

/** Where a shared trail opens: my own in the Library's trail view, a teammate's in the team's. */
export function trailUrl(owner: string, trackId: string, me: string, photoId?: string): string {
  if (owner === me) return photoId ? `/photo/${trackId}/${photoId}` : `/trail3d/${trackId}`;
  const q = photoId ? `?photo=${photoId}` : '';
  return `/team/trail/${owner}/${trackId}${q}`;
}

export function alertFor(
  state: TeamState,
  op: SignedOp,
  body: Json | undefined,
  me: string,
  ctx: AlertContext,
): TeamAlert | null {
  if (!isRecord(body) || !ctx.applied(op.id)) return null;
  if (op.env.t === 'msg') return messageAlert(state, op, body, me, ctx);
  if (op.env.t === 'e.set' && body['k'] === 'comment')
    return commentAlert(state, op, body, me, ctx);
  if (op.env.t === 'e.set' && body['k'] === 'task') return taskAlert(state, op, body, me, ctx);
  if (op.env.t === 'e.set' && body['k'] === 'sos') return sosAlert(state, op, body, me, ctx);
  return null;
}

function messageAlert(
  state: TeamState,
  op: SignedOp,
  body: Record<string, Json>,
  me: string,
  ctx: AlertContext,
): TeamAlert | null {
  const th = body['th'];
  const tx = body['tx'];
  const id = body['id'];
  if (typeof th !== 'string' || typeof tx !== 'string' || typeof id !== 'string') return null;
  if (isSystemThread(th)) return null;
  let level = routeDelivery(state, op, body, me);
  let url = '/team/chat';
  let kind: TeamAlert['kind'] = 'message';
  if (th.startsWith(TRAIL_THREAD_PREFIX)) {
    const trackId = th.slice(TRAIL_THREAD_PREFIX.length);
    const owner = ctx.trailOwner(trackId);
    if (owner === undefined) return null;
    kind = 'comment';
    url = trailUrl(owner, trackId, me);
    if (owner === me && op.env.au !== me && level !== 'none') level = 'alert';
  } else if (th.startsWith(PIN_THREAD_PREFIX)) {
    const pin = parsePinThread(th);
    if (pin === null || !ctx.hasPin(pin.owner, pin.id)) return null;
    kind = 'comment';
    url = pinUrl(pin.owner, pin.id);
    if (pin.owner === me && op.env.au !== me && level !== 'none') level = 'alert';
  } else if (th !== TEAM_THREAD) {
    return null;
  }
  if (level !== 'badge' && level !== 'alert') return null;
  return {
    key: `${op.env.au}:${id}`,
    author: op.env.au,
    level,
    kind,
    text: tx,
    priority: op.env.pr ?? 0,
    url,
  };
}

function commentAlert(
  state: TeamState,
  op: SignedOp,
  body: Record<string, Json>,
  me: string,
  ctx: AlertContext,
): TeamAlert | null {
  const id = body['id'];
  const f = body['f'];
  if (typeof id !== 'string' || !isRecord(f)) return null;
  const photoId = f['photoId'];
  const text = f['text'];
  if (typeof photoId !== 'string' || typeof text !== 'string') return null;
  const self = state.members.get(me);
  if (op.env.au === me || self?.status !== 'active') return null;
  const photo = ctx.photo(photoId);
  if (photo === undefined) return null;
  const mentions = Array.isArray(f['mentions']) ? f['mentions'] : [];
  let level: TeamAlert['level'] | null;
  if (photo.owner === me || mentions.includes(me)) level = 'alert';
  else {
    const sender = state.members.get(op.env.au);
    const small = audienceMembers(state, undefined).length <= LARGE_TEAM;
    level = small || (sender !== undefined && isAdminRole(sender.role)) ? 'badge' : null;
  }
  if (level === null) return null;
  return {
    key: `${op.env.au}:${id}`,
    author: op.env.au,
    level,
    kind: 'comment',
    text,
    priority: 0,
    url: trailUrl(photo.owner, photo.trackId, me, photoId),
  };
}

function taskAlert(
  state: TeamState,
  op: SignedOp,
  body: Record<string, Json>,
  me: string,
  ctx: AlertContext,
): TeamAlert | null {
  const id = body['id'];
  const f = body['f'];
  if (typeof id !== 'string' || !isRecord(f)) return null;
  const self = state.members.get(me);
  if (op.env.au === me || self?.status !== 'active') return null;
  const owner = typeof body['o'] === 'string' ? body['o'] : op.env.au;
  // What the fold merged, not what the op claims (review #1).
  const task = ctx.task(owner, id);
  if (task === undefined) return null;
  let text: string;
  if (f['assignee'] === me && task.assignee === me) text = `New task for you: ${cap(task.title)}`;
  else if (f['done'] === true && task.done && task.owner === me) text = `Done: ${cap(task.title)}`;
  else return null;
  return {
    key: `task:${op.id}`,
    author: op.env.au,
    level: 'alert',
    kind: 'task',
    text,
    priority: 0,
    url: TASKS_URL,
  };
}

/** How long task alerts from one teammate collapse into one notification. */
export const TASK_ALERT_WINDOW_MS = 60_000;

/**
 * Collapses a burst of task alerts from one author (review #6): the first in
 * a {@link TASK_ALERT_WINDOW_MS} window notifies; the next ones only update
 * the banner ("4 new tasks for you", level `badge`). Other alerts pass.
 */
export class TaskAlertThrottle {
  private readonly bursts = new Map<string, { start: number; count: number }>();

  admit(alert: TeamAlert, now: number): TeamAlert {
    if (alert.kind !== 'task') return alert;
    const b = this.bursts.get(alert.author);
    if (b === undefined || now - b.start > TASK_ALERT_WINDOW_MS) {
      this.bursts.set(alert.author, { start: now, count: 1 });
      return alert;
    }
    b.count += 1;
    return { ...alert, level: 'badge', text: `${b.count} task updates for you` };
  }
}

/**
 * An SOS alerts every active member but the raiser: always an `alert`, at
 * priority 2, whatever the team's size (the 30-member rule and the task
 * throttle never apply). Its resolution is a badge. Text from the merged record.
 */
function sosAlert(
  state: TeamState,
  op: SignedOp,
  body: Record<string, Json>,
  me: string,
  ctx: AlertContext,
): TeamAlert | null {
  const id = body['id'];
  const f = body['f'];
  if (typeof id !== 'string' || !isRecord(f)) return null;
  const self = state.members.get(me);
  if (op.env.au === me || self?.status !== 'active') return null;
  const owner = typeof body['o'] === 'string' ? body['o'] : op.env.au;
  if (owner === me) {
    // Someone resolved my SOS.
    const mine = ctx.sos?.(owner, id);
    if (mine === undefined || f['res'] !== true || !mine.resolved) return null;
    return {
      key: `sos:${op.id}`,
      author: op.env.au,
      level: 'badge',
      kind: 'sos',
      text: 'Your SOS was resolved',
      priority: 0,
      url: SOS_URL(owner, id),
    };
  }
  const sos = ctx.sos?.(owner, id);
  if (sos === undefined) return null;
  // Only the creating write alerts (re-writing the place of an open SOS doesn't re-alert).
  const raise = typeof f['la'] === 'number' && !sos.resolved && sos.createdWall === op.stamp.wall;
  const resolved = f['res'] === true && sos.resolved;
  if (!raise && !resolved) return null;
  return {
    key: `sos:${op.id}`,
    author: owner,
    level: raise ? 'alert' : 'badge',
    kind: 'sos',
    text: raise ? `SOS${sos.text ? ` · ${cap(sos.text)}` : ' · needs help'}` : 'SOS resolved',
    priority: raise ? 2 : 0,
    url: SOS_URL(owner, id),
  };
}

const SOS_URL = (owner: string, id: string) => `/team/sos/${owner}/${id}`;
