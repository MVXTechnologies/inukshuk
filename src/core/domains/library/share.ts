import type { Json } from '@core/team/canonical';
import type { Role } from '@core/team/roles';
import type { GroupMeta } from '@core/group/meta';

import { LFO, LIT } from './kinds';
import { TOP, type LibraryView } from './tree';

/**
 * Sharing rules for #712 (owner decision 2026-10-16: **a shared folder is its
 * own group, apart from team mode**: its own members, invites and
 * connectivity; no seeding from a team, no following one):
 *
 * - people join by the folder's own invite, at the role it makes (editors by
 *   default, owner #712 Q1);
 * - **leaving keeps a copy**: the shared tree becomes a normal folder;
 * - **folders sync only while the app is open** (owner Q3-A).
 */

/** A member a successor group adds (renewal), with what `m.add` needs. */
export interface MemberPlan {
  id: string;
  /** X25519 box key (base64url), from the old group's roster. */
  x: string;
  role: Role;
}

/** Joiners' default role in a shared folder: editor (owner #712 Q1). */
export const DEFAULT_LIBRARY_ROLE: Role = 'member';

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
