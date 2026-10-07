import type { Json } from './canonical';
import type { SignedOp } from './envelope';
import { isRecord } from './canonical';
import { activeMembers, type TeamState } from './membership';
import { inAudience, isAdminRole, parseAudience, type Audience } from './roles';

/**
 * Fan-out and notification routing (#589, owner B4).
 *
 * **Fan-out is total; delivery is targeted.** Every member's phone stores and
 * relays every op (that is what lets any phone fill in a phone that was
 * away). The audience decides what each phone *does* with an op:
 *
 * - `none`   — not for me (outside the audience, my own op, or I'm not
 *   active). Stored and relayed, never shown in my feeds.
 * - `silent` — shown in the relevant screen, no badge, no sound.
 * - `badge`  — unread count only.
 * - `alert`  — a notification.
 *
 * Rules, first match wins:
 * 1. my own op, or I'm not an active member → `none`;
 * 2. not in the op's audience → `none`;
 * 3. positions → `silent`;
 * 4. a task assigned to me → `alert`; other entity edits → `silent`;
 * 5. message: urgent (pr 2) → `alert`; mentions me or a DM to me → `alert`;
 *    important (pr 1) → `badge`… and also `alert` when it is from an admin;
 * 6. a normal message → `badge` in a small team or when it is narrowly
 *    targeted (audience ≤ {@link LARGE_TEAM}), or when it comes from an admin
 *    or a lead of one of my groups; otherwise (a 100-person event's chatter)
 *    → `silent`.
 *
 * Confidentiality is a separate matter: an audience on a group-encrypted op is
 * readable by every member's app (it just isn't shown). Narrow audiences that
 * must stay private use sealed encryption (DMs: always).
 */
export const LARGE_TEAM = 30;

export type Delivery = 'none' | 'silent' | 'badge' | 'alert';

/** Members an audience resolves to right now (sorted ids). */
export function audienceMembers(state: TeamState, aud: Audience | undefined): string[] {
  return activeMembers(state)
    .filter((m) => inAudience(aud, m, state.groups))
    .map((m) => m.id);
}

export function routeDelivery(
  state: TeamState,
  op: SignedOp,
  body: Json | undefined,
  me: string,
): Delivery {
  const { env } = op;
  const self = state.members.get(me);
  if (env.au === me || self === undefined || self.status !== 'active') return 'none';
  const aud = env.aud === undefined ? undefined : parseAudience(env.aud);
  if (env.aud !== undefined && aud === undefined) return 'none';
  const sealedToMe = env.x?.w.some(([id]) => id === me);
  if (env.x !== undefined && !sealedToMe) return 'none';
  if (!inAudience(aud, self, state.groups) && !sealedToMe) return 'none';

  if (env.t === 'pos') return 'silent';
  if (env.t === 'e.set') {
    const f = isRecord(body) && isRecord(body['f']) ? body['f'] : undefined;
    return isRecord(body) && body['k'] === 'task' && f?.['assignee'] === me ? 'alert' : 'silent';
  }
  if (env.t !== 'msg') return 'silent';

  const sender = state.members.get(env.au);
  const senderIsAdmin = sender !== undefined && isAdminRole(sender.role);
  const mentions = isRecord(body) && Array.isArray(body['mn']) ? body['mn'] : [];
  const thread = isRecord(body) && typeof body['th'] === 'string' ? body['th'] : '';
  if (env.pr === 2) return 'alert';
  if (mentions.includes(me) || thread === `dm:${me}`) return 'alert';
  if (env.pr === 1) return senderIsAdmin ? 'alert' : 'badge';

  const narrow = audienceMembers(state, aud).length <= LARGE_TEAM;
  const myLead =
    sender !== undefined &&
    sender.groups.some((l) => l.lead === true && self.groups.some((mine) => mine.g === l.g));
  return narrow || senderIsAdmin || myLead ? 'badge' : 'silent';
}
