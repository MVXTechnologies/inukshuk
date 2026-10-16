import type { Json } from '@core/team/canonical';
import { isLive, visibleFields } from '@core/team/crdt';
import type { TeamData } from '@core/team/data';
import { isTeamId } from '@core/team/ids';
import { activeMembers, type TeamState } from '@core/team/membership';
import { canGrantRole, canManage, isAdminRole, type Role } from '@core/team/roles';
import type { GroupMeta } from '@core/group/meta';
import { GREF } from '@core/domains/team/groupKinds';

import { LFO, LIT } from './kinds';
import { TOP, type LibraryView } from './tree';

/**
 * The owner's sharing rules for #712 (design §3.4; owner answers Q2-A, Q3-A,
 * Q4-A), as pure plans the data layer (G10) carries out with the existing
 * membership actions:
 *
 * - **A folder shared with a team is its own group, seeded from the team**:
 *   its members are added from the team's roster (their ids and box keys are
 *   already there), with no invites.
 * - **Team members get team folders automatically** (`gmeta.follow`): a
 *   folder manager's phone adds whoever the team admits, and removes from the
 *   folder whoever the team removes. Members added to the folder by hand
 *   (not via the team) are never touched, and someone removed from the folder
 *   alone is never re-added.
 * - **Leaving keeps a copy**: the shared tree becomes a normal folder.
 * - **Folders sync only while the app is open**: background sync stays the
 *   active team's (as in 2.6).
 */

/** A member to add to a library group, with what `m.add` needs. */
export interface MemberPlan {
  id: string;
  /** X25519 box key (base64url), from the team's roster. */
  x: string;
  role: Role;
}

/** Joiners' default role in a shared folder: editor (owner #712 Q1). */
export const DEFAULT_LIBRARY_ROLE: Role = 'member';

/**
 * Who the sharer adds when sharing with a team: each picked id that is an
 * active team member (not the sharer), at the role picked (a role the sharer,
 * as the folder's owner, may grant). Unknown or removed ids are dropped.
 */
export function seedPlan(
  team: Readonly<TeamState>,
  me: string,
  picks: readonly { id: string; role?: Role }[],
): MemberPlan[] {
  const out = new Map<string, MemberPlan>();
  for (const p of picks) {
    const m = team.members.get(p.id);
    if (m === undefined || m.status !== 'active' || m.id === me || out.has(m.id)) continue;
    const role = p.role ?? DEFAULT_LIBRARY_ROLE;
    if (!canGrantRole('owner', role)) continue;
    out.set(m.id, { id: m.id, x: m.x, role });
  }
  return [...out.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

export interface FollowPlan {
  add: MemberPlan[];
  /** Member ids to remove from the folder (then rotate its key). */
  remove: string[];
}

const NOTHING: FollowPlan = { add: [], remove: [] };

/**
 * What a folder manager's phone does so the folder follows its team
 * (`gmeta.follow`, `gmeta.parent` = the team): add active team members the
 * folder never had, remove folder members the team removed. Empty unless
 * this phone may do it (an active manager of the folder). Duplicate plans
 * from two managers are harmless: the membership fold refuses the second.
 */
export function followPlan(
  team: Readonly<TeamState>,
  folder: Readonly<TeamState>,
  meta: Readonly<GroupMeta>,
  me: string,
  role: Role = DEFAULT_LIBRARY_ROLE,
): FollowPlan {
  const mine = folder.members.get(me);
  if (
    !meta.follow ||
    meta.parent !== team.teamId ||
    mine === undefined ||
    mine.status !== 'active' ||
    !isAdminRole(mine.role) ||
    !canGrantRole(mine.role, role)
  )
    return NOTHING;
  const add: MemberPlan[] = [];
  for (const m of activeMembers(team as TeamState))
    if (!folder.members.has(m.id)) add.push({ id: m.id, x: m.x, role });
  const remove: string[] = [];
  for (const m of activeMembers(folder as TeamState)) {
    const t = team.members.get(m.id);
    if (t?.status === 'removed' && m.id !== me && canManage(mine.role, m.role)) remove.push(m.id);
  }
  return { add, remove };
}

/** A folder shared through a team, announced there by a `gref` record. */
export interface SharedRef {
  /** The library group's id. */
  group: string;
  name?: string;
  /** Who shared it. */
  by: string;
}

/**
 * The library groups announced in a team (its `gref` records, `app: 'lib'`):
 * what a team member's phone asks to open, so team folders arrive on their
 * own. One entry per group (the oldest announcement names it).
 */
export function sharedRefs(teamData: Readonly<TeamData>): SharedRef[] {
  const out = new Map<string, { ref: SharedRef; at: number }>();
  for (const rec of teamData.entities.values()) {
    if (rec.kind !== GREF || rec.owner === undefined || !isLive(rec.state)) continue;
    const f = visibleFields(rec.state);
    if (f['app'] !== 'lib' || !isTeamId(rec.id)) continue;
    const at = rec.state.created?.wall ?? 0;
    const prev = out.get(rec.id);
    if (prev !== undefined && (prev.at < at || (prev.at === at && prev.ref.by < rec.owner)))
      continue;
    const ref: SharedRef = { group: rec.id, by: rec.owner };
    if (typeof f['name'] === 'string') ref.name = f['name'];
    out.set(rec.id, { ref, at });
  }
  return [...out.values()].map((e) => e.ref).sort((a, b) => (a.group < b.group ? -1 : 1));
}

/** Whether a group syncs in the background: teams only (owner Q3-A); folders while the app is open. */
export function syncsInBackground(meta: Readonly<GroupMeta>): boolean {
  return meta.app === 'team';
}

/** One node of a detached copy. */
export interface CopyNode {
  kind: typeof LFO | typeof LIT;
  id: string;
  /** The parent folder in the copy (absent at its top). */
  parent?: string;
  name: string;
  /** The record's fields (base and trash flag dropped). */
  fields: Record<string, Json>;
}

/**
 * "Leave, keep a copy" (owner Q4-A): the shared tree as a normal folder,
 * trash left out, parents before children. The bridge writes it to the
 * Library and forgets the group.
 */
export function detachedCopy(view: LibraryView): CopyNode[] {
  const out: CopyNode[] = [];
  const top = view.root !== undefined && view.folders.has(view.root) ? view.root : TOP;
  const visit = (parent: string) => {
    for (const n of view.children.get(parent) ?? []) {
      const fields = { ...n.fields };
      delete fields['rm'];
      const c: CopyNode = { kind: n.kind, id: n.id, name: n.name, fields };
      if (parent !== TOP) c.parent = parent;
      out.push(c);
      if (n.kind === LFO) visit(n.id);
    }
  };
  if (top !== TOP) {
    const r = view.folders.get(top)!;
    const fields = { ...r.fields };
    delete fields['rm'];
    delete fields['p'];
    out.push({ kind: LFO, id: r.id, name: r.name, fields });
  }
  visit(top);
  return out;
}
