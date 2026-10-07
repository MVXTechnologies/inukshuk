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
import type { SignedOp } from '@core/team/envelope';
import type { TeamState } from '@core/team/membership';
import { audienceMembers, LARGE_TEAM, routeDelivery } from '@core/team/notify';
import { isAdminRole } from '@core/team/roles';

import { TRAIL_THREAD_PREFIX } from './comments';
import { PIN_THREAD_PREFIX } from './pins';
import { isSystemThread } from './system';
import { TEAM_THREAD } from './view';

export interface TeamAlert {
  /** `author:id` of the message or comment, for de-duplication. */
  key: string;
  author: string;
  level: 'badge' | 'alert';
  kind: 'message' | 'comment' | 'task';
  text: string;
  priority: 0 | 1 | 2;
  /** The route tapping it opens. */
  url: string;
}

/** What alert routing needs to know about shared trails and photos (from the data view). */
export interface AlertContext {
  photo(photoId: string): { owner: string; trackId: string } | undefined;
  trailOwner(trackId: string): string | undefined;
  /** The author of the pin `id`, when it is known. */
  pinOwner?(id: string): string | undefined;
  /** A task's current title and assignee. */
  task?(owner: string, id: string): { title: string; assignee: string } | undefined;
}

/** Where a pin opens: the map, with its card. */
export function pinUrl(id: string): string {
  return `/team/pin/${id}`;
}

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
  if (!isRecord(body)) return null;
  if (op.env.t === 'msg') return messageAlert(state, op, body, me, ctx);
  if (op.env.t === 'e.set' && body['k'] === 'comment')
    return commentAlert(state, op, body, me, ctx);
  if (op.env.t === 'e.set' && body['k'] === 'task') return taskAlert(state, op, body, me, ctx);
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
    const pinId = th.slice(PIN_THREAD_PREFIX.length);
    const owner = id === pinId ? op.env.au : ctx.pinOwner?.(pinId);
    if (owner === undefined) return null;
    kind = 'comment';
    url = pinUrl(pinId);
    if (owner === me && op.env.au !== me && level !== 'none') level = 'alert';
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
  const known = ctx.task?.(owner, id);
  const title = typeof f['title'] === 'string' ? f['title'] : known?.title;
  if (title === undefined) return null;
  let text: string;
  if (f['assignee'] === me) text = `New task for you: ${title}`;
  else if (f['done'] === true && owner === me) text = `Done: ${title}`;
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
