import type { Json } from '@core/team/canonical';
import { isLive, visibleFields } from '@core/team/crdt';
import type { TeamData } from '@core/team/data';
import { isTeamId } from '@core/team/ids';
import { activeMembers, MAX_TEAM_LIFETIME_MS, type TeamState } from '@core/team/membership';
import { isAdminRole, type Role } from '@core/team/roles';
import { BASE_FIELD } from '@core/group/conflicts';
import { recordKey } from '@core/group/registry';

import { COPY_FIELD, CURSOR_ID, LFO, LIT, LNX, LPT } from './kinds';
import type { MemberPlan } from './share';
import type { SetBody } from './writes';

/**
 * Renewal: a shared folder outlives its group's year (2.7.0 #712).
 *
 * A sync group's membership is signed under rules frozen in envelope v1, and
 * its lifetime is capped at {@link MAX_TEAM_LIFETIME_MS} from its genesis:
 * after that every op is refused. A library is meant to last, so before the
 * year is up a manager's phone **rolls it forward** into a successor group,
 * using only the existing signed rules:
 *
 * 1. a new group (new genesis, new key) with `gmeta { …, prev: old }`;
 * 2. every active member added at the same role (`m.add` with their box key
 *    from the old group's roster; the old owner becomes a manager: one owner
 *    per group);
 * 3. every live folder, item (trash included) and trail part copied, marked
 *    `cp: 1` (a copy, not anybody's change: Activity skips it);
 * 4. `lnx { g: successor }` written in the old group (while it still takes
 *    writes), which every member's phone follows: it picks the successor up
 *    through the old group's links, and its bridge moves to it.
 *
 * Two managers renewing at once is harmless: `lnx` is one LWW record, so
 * every phone follows the same successor, and the other one is closed by its
 * creator. The owner renews from day {@link RENEW_OWNER_MS}, other managers
 * from day {@link RENEW_MANAGER_MS}, so usually exactly one phone does.
 */
const DAY = 24 * 60 * 60 * 1000;
export const RENEW_OWNER_MS = 300 * DAY;
export const RENEW_MANAGER_MS = 320 * DAY;
/** A superseded group is kept this long past its expiry (stragglers learn the successor from it). */
export const SUPERSEDED_KEEP_MS = 90 * DAY;

/** The successor named by a library group's `lnx`, if any. */
export function successorOf(data: Readonly<TeamData>): string | undefined {
  const rec = data.entities.get(recordKey(false, LNX, CURSOR_ID));
  if (rec === undefined || !isLive(rec.state)) return undefined;
  const g = visibleFields(rec.state)['g'];
  return isTeamId(g) ? g : undefined;
}

/** Whether this phone should renew the group now. */
export function renewDue(state: Readonly<TeamState>, me: string, now: number): boolean {
  const mine = state.members.get(me);
  const born = state.genesis?.stamp.wall;
  if (mine?.status !== 'active' || !isAdminRole(mine.role) || born === undefined) return false;
  if (state.closedAt !== undefined || now > state.expiresAt) return false;
  return now >= born + (mine.role === 'owner' ? RENEW_OWNER_MS : RENEW_MANAGER_MS);
}

/** Who the successor adds (everyone active but the renewer, at their role; the owner as a manager). */
export function successorMembers(state: Readonly<TeamState>, me: string): MemberPlan[] {
  return activeMembers(state as TeamState)
    .filter((m) => m.id !== me)
    .map((m) => ({ id: m.id, x: m.x, role: (m.role === 'owner' ? 'admin' : m.role) as Role }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** The copies a successor starts with: live folders and items (trash too), then trail parts. */
export function snapshotBodies(data: Readonly<TeamData>): SetBody[] {
  const tree: SetBody[] = [];
  const parts: SetBody[] = [];
  for (const rec of data.entities.values()) {
    if (rec.kind !== LFO && rec.kind !== LIT && rec.kind !== LPT) continue;
    if (!isLive(rec.state)) continue;
    const f: Record<string, Json> = visibleFields(rec.state);
    delete f[BASE_FIELD];
    if (rec.kind === LPT) parts.push({ k: LPT, id: rec.id, f });
    else tree.push({ k: rec.kind, id: rec.id, f: { ...f, [COPY_FIELD]: 1 } });
  }
  // Folders first (their items name them), then items; parts last.
  tree.sort((a, b) => (a.k === b.k ? (a.id < b.id ? -1 : 1) : a.k === LFO ? -1 : 1));
  return [...tree, ...parts.sort((a, b) => (a.id < b.id ? -1 : 1))];
}

/** The lifetime a library group is created with (the protocol's maximum). */
export const LIBRARY_LIFETIME_MS = MAX_TEAM_LIFETIME_MS;
