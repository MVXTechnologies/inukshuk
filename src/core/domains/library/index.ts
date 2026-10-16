import { isLive, visibleFields, type EntityState } from '@core/team/crdt';
import type { EntityRecord, TeamData } from '@core/team/data';
import { isAdminRole, type Role } from '@core/team/roles';
import { has, knownFieldsValid, rewritesOnce } from '@core/group/fields';
import { groupMeta, groupPlugin } from '@core/group/meta';
import {
  DomainRegistry,
  recordKey,
  type Authorization,
  type DomainPlugin,
  type KindWrite,
} from '@core/group/registry';

import {
  CURSOR_ID,
  isOwnedLibraryKind,
  isTreeKind,
  LFO,
  LIBRARY_KINDS,
  LIT,
  LPT,
  MAX_FOLDERS,
  MAX_ITEMS,
  SPECS,
} from './kinds';
import { libraryView, type LibraryView } from './tree';

/**
 * The library domain (plug-in #2 of the sync-group seam, 2.7.0 #712;
 * `docs/design/sync-layer.md` §5.3). A shared folder or item is its own sync
 * group (`gmeta { app: 'lib', root }`); this plug-in decides which of its
 * record writes the fold keeps. Kinds and fields: `kinds.ts`.
 *
 * **Roles** (the frozen v1 ranks, named for the library):
 * - owner / admin = **manager**: everything editors do, plus purge;
 * - member = **editor**: create, rename, move, edit, soft-delete, restore;
 * - guest = **viewer**: their own comments and activity cursor only.
 *
 * **Rules decided at the op's fold position** (deterministic, order-free):
 * - a record's first write names it (`n`; an item also its type `t`, which
 *   never changes);
 * - the shared root (`gmeta.root`) is never trashed, moved or purged: ending a
 *   share is a group action, not a delete;
 * - a purged record never comes back (a later write to it is forbidden);
 * - a purge (`e.del`) is a manager's, and only of something in the trash;
 * - at most {@link MAX_ITEMS} items and {@link MAX_FOLDERS} folders exist
 *   (purged ones free their slot).
 *
 * Tree shape (cycles from concurrent moves, depth) is not refused here: two
 * moves that are each fine can only be judged together, so the view resolves
 * them deterministically (`tree.ts`) and local edits check first
 * (`checkMove`).
 */
export const LIBRARY_DOMAIN = 'lib';

interface Counts {
  [LFO]: number;
  [LIT]: number;
}

/**
 * Live (unpurged) folders and items per data view, kept in step by `merged`.
 * Keyed by the view's entity map: a rebuilt view is a new map, and a view
 * this module has not seen yet is counted once.
 */
const counts = new WeakMap<object, Counts>();

const alive = (rec: { state: EntityState } | undefined): boolean =>
  rec !== undefined && isLive(rec.state);

function countsOf(view: Readonly<TeamData>): Counts {
  let c = counts.get(view.entities);
  if (c === undefined) {
    c = { [LFO]: 0, [LIT]: 0 };
    for (const rec of view.entities.values())
      if ((rec.kind === LFO || rec.kind === LIT) && alive(rec)) c[rec.kind] += 1;
    counts.set(view.entities, c);
  }
  return c;
}

const treeKey = (kind: string, id: string) => recordKey(false, kind, id);

/**
 * Whether a tree record is in the trash at this fold position: trashed
 * itself, or under a trashed or purged folder (raw parent links, cycle-safe).
 */
export function inTrash(view: Readonly<TeamData>, kind: string, id: string): boolean {
  let rec = view.entities.get(treeKey(kind, id));
  const visited = new Set<string>();
  while (rec !== undefined) {
    if (!isLive(rec.state)) return true;
    const f = visibleFields(rec.state);
    if (f['rm'] === 1) return true;
    const p = f['p'];
    if (typeof p !== 'string' || visited.has(p)) return false;
    visited.add(p);
    rec = view.entities.get(treeKey(LFO, p));
  }
  return false;
}

function authorizeTree(w: KindWrite, role: Role, view: Readonly<TeamData>): Authorization {
  const cur = view.entities.get(treeKey(w.kind, w.id));
  const root = groupMeta(view).root;
  if (w.op === 'del') {
    // Purge: a manager's, of a record in the trash; never the shared root.
    if (!isAdminRole(role) || cur === undefined || !isLive(cur.state) || w.id === root)
      return 'forbidden';
    return inTrash(view, w.kind, w.id) ? { owner: undefined } : 'forbidden';
  }
  if (role === 'guest') return 'forbidden';
  const spec = SPECS.get(w.kind)!;
  if (!knownFieldsValid(w.f, spec.rules)) return 'invalid';
  // A folder is never its own parent.
  if (w.kind === LFO && w.f['p'] === w.id) return 'invalid';
  if (cur === undefined) {
    if (!spec.first.every((k) => has(w.f, k))) return 'invalid';
    const c = countsOf(view);
    if (c[w.kind as typeof LFO | typeof LIT] >= (w.kind === LFO ? MAX_FOLDERS : MAX_ITEMS))
      return 'forbidden';
  } else {
    // Purged for good.
    if (cur.state.deleted !== undefined) return 'forbidden';
    if (rewritesOnce(cur.state, w.f, spec.once)) return 'forbidden';
  }
  if (w.id === root && (w.f['rm'] === 1 || has(w.f, 'p'))) return 'forbidden';
  return { owner: undefined };
}

function authorizeOwned(w: KindWrite, role: Role, view: Readonly<TeamData>): Authorization {
  const owner = w.o ?? w.author;
  if (w.op === 'del') return owner === w.author || isAdminRole(role) ? { owner } : 'forbidden';
  const spec = SPECS.get(w.kind)!;
  if (!knownFieldsValid(w.f, spec.rules)) return 'invalid';
  const cur = view.entities.get(recordKey(true, w.kind, w.id, owner))?.state;
  if (cur === undefined && !spec.first.every((k) => has(w.f, k))) return 'invalid';
  if (rewritesOnce(cur, w.f, spec.once)) return 'forbidden';
  return { owner };
}

/** A trail part: an editor's, written once, complete at its first write; a manager purges. */
function authorizePart(w: KindWrite, role: Role, view: Readonly<TeamData>): Authorization {
  const cur = view.entities.get(treeKey(LPT, w.id));
  if (w.op === 'del')
    return isAdminRole(role) && cur !== undefined && isLive(cur.state)
      ? { owner: undefined }
      : 'forbidden';
  if (role === 'guest') return 'forbidden';
  const spec = SPECS.get(LPT)!;
  if (!knownFieldsValid(w.f, spec.rules)) return 'invalid';
  if (cur === undefined) {
    if (!spec.first.every((k) => has(w.f, k))) return 'invalid';
    if ((w.f['n'] as number) >= (w.f['of'] as number)) return 'invalid';
    return { owner: undefined };
  }
  if (cur.state.deleted !== undefined) return 'forbidden';
  return rewritesOnce(cur.state, w.f, spec.once) ? 'forbidden' : { owner: undefined };
}

export const libraryPlugin: DomainPlugin<LibraryView> = {
  id: LIBRARY_DOMAIN,
  kinds: LIBRARY_KINDS,
  owned: isOwnedLibraryKind,
  baseStamps: true,
  validate(w) {
    if (isTreeKind(w.kind) || w.kind === LPT) return w.o === undefined;
    // Owned: `o` names another's record on a delete only; the cursor is one per member.
    if (w.o !== undefined && w.op !== 'del') return false;
    return w.kind !== 'lac' || w.id === CURSOR_ID;
  },
  authorize(w, role, view) {
    if (w.kind === LPT) return authorizePart(w, role, view);
    return isTreeKind(w.kind) ? authorizeTree(w, role, view) : authorizeOwned(w, role, view);
  },
  merged(view, rec: Readonly<EntityRecord>, before) {
    if (rec.kind !== LFO && rec.kind !== LIT) return;
    const c = counts.get(view.entities);
    // Not counted yet: the first count includes this record.
    if (c === undefined) {
      countsOf(view);
      return;
    }
    const was = before !== undefined && isLive(before);
    const is = isLive(rec.state);
    if (was !== is) c[rec.kind] += is ? 1 : -1;
  },
  view: (data) => libraryView(data),
  // Edits go out live; catch-up is the session's lane.
  lane: () => 1,
};

let shared: DomainRegistry | undefined;

/** The registry of a library group (the group kinds + the library domain), frozen and shared. */
export function libraryRegistry(): DomainRegistry {
  shared ??= new DomainRegistry([groupPlugin, libraryPlugin]).freeze();
  return shared;
}
