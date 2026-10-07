/**
 * What the app does when a teammate's op arrives (#589 UI). The routing is
 * the core's (`routeDelivery`, spec §9): `alert` buzzes and shows a banner,
 * `badge` only counts as unread, `silent` and `none` do nothing. Ordinary
 * chatter in a team of more than 30 people stays silent unless it comes
 * from an admin or a lead of one of my groups ("buzz above 30 members").
 *
 * On top of the core's rules: `sys:` threads (`./system`) never notify, and
 * only messages on the team channel do in v1's UI. Pure.
 */
import type { Json } from '@core/team/canonical';
import { isRecord } from '@core/team/canonical';
import type { SignedOp } from '@core/team/envelope';
import type { TeamState } from '@core/team/membership';
import { routeDelivery } from '@core/team/notify';

import { isSystemThread } from './system';
import { TEAM_THREAD } from './view';

export interface TeamAlert {
  /** Entity key of the message (`author:id`), for de-duplication. */
  key: string;
  author: string;
  level: 'badge' | 'alert';
  text: string;
  priority: 0 | 1 | 2;
}

export function alertFor(
  state: TeamState,
  op: SignedOp,
  body: Json | undefined,
  me: string,
): TeamAlert | null {
  if (op.env.t !== 'msg' || !isRecord(body)) return null;
  const th = body['th'];
  const tx = body['tx'];
  const id = body['id'];
  if (typeof th !== 'string' || typeof tx !== 'string' || typeof id !== 'string') return null;
  if (isSystemThread(th) || th !== TEAM_THREAD) return null;
  const level = routeDelivery(state, op, body, me);
  if (level !== 'badge' && level !== 'alert') return null;
  return {
    key: `${op.env.au}:${id}`,
    author: op.env.au,
    level,
    text: tx,
    priority: op.env.pr ?? 0,
  };
}
