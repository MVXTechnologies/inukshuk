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
 * - every alert carries where tapping it goes (`url`). Pure.
 */
import type { Json } from '@core/team/canonical';
import { isRecord } from '@core/team/canonical';
import type { SignedOp } from '@core/team/envelope';
import type { TeamState } from '@core/team/membership';
import { audienceMembers, LARGE_TEAM, routeDelivery } from '@core/team/notify';
import { isAdminRole } from '@core/team/roles';

import { TRAIL_THREAD_PREFIX } from './comments';
import { isSystemThread } from './system';
import { TEAM_THREAD } from './view';

export interface TeamAlert {
  /** `author:id` of the message or comment, for de-duplication. */
  key: string;
  author: string;
  level: 'badge' | 'alert';
  kind: 'message' | 'comment';
  text: string;
  priority: 0 | 1 | 2;
  /** The route tapping it opens. */
  url: string;
}

/** What alert routing needs to know about shared trails and photos (from the data view). */
export interface AlertContext {
  photo(photoId: string): { owner: string; trackId: string } | undefined;
  trailOwner(trackId: string): string | undefined;
}

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
