import type { Json } from '@core/team/canonical';
import { compareStamp, type Stamp } from '@core/team/hlc';
import { isLive, lastWrite, own, visibleFields, type EntityState } from '@core/team/crdt';
import type { TeamData } from '@core/team/data';
import { BASE_FIELD } from '@core/group/conflicts';
import { groupMeta } from '@core/group/meta';

import { LFO, LIT, MAX_FOLDER_DEPTH } from './kinds';

/**
 * The library tree as every phone shows it (2.7.0 #712, design §4.3), derived
 * from the folded records alone, so it is the same everywhere whatever order
 * the ops came in.
 *
 * Parents are LWW fields, so concurrent moves can build what no single move
 * could. The view repairs that deterministically:
 * - **cycles** ("A into B while B into A"): in each cycle, the folder whose
 *   `p` write is the oldest (stamp, then id) goes back under the root;
 * - **depth**: a folder deeper than {@link MAX_FOLDER_DEPTH} below the root
 *   sits beside its deepest allowed ancestor instead;
 * - **dangling parents** (a folder never synced, or bad): under the root;
 * - **purged parents**: under the root, in the trash (purging a folder never
 *   pops its contents back into the library).
 */

/** The parent key of the share's top level when the root is not a folder. */
export const TOP = '';

export interface LibNode {
  kind: typeof LFO | typeof LIT;
  id: string;
  /** Visible fields without the base. */
  fields: Record<string, Json>;
  name: string;
  /** The effective parent folder ({@link TOP} at the top; the root folder's own is {@link TOP}). */
  parent: string;
  /** Folders: 0 for the root folder, 1 for its children…; items: their folder's + 1. */
  depth: number;
  /** Trashed itself (`rm: 1`). */
  trashed: boolean;
  /** Trashed itself, or under a trashed or purged folder. */
  inTrash: boolean;
  /** When and by whom it was trashed (the `rm` register's stamp). */
  trashedAt?: Stamp;
  /** The newest write to it. */
  changed: Stamp;
  created?: Stamp;
}

export type Repair = 'cycle' | 'depth' | 'dangling';

export interface LibraryView {
  /** `gmeta.root`: the shared folder or item (absent before the group says). */
  root: string | undefined;
  folders: ReadonlyMap<string, LibNode>;
  items: ReadonlyMap<string, LibNode>;
  /** Out-of-trash children by parent key: folders, then items, each in display order. */
  children: ReadonlyMap<string, readonly LibNode[]>;
  /** Folders whose `p` the view could not follow, and why. */
  repaired: ReadonlyMap<string, Repair>;
}

const register = (s: EntityState, f: string) => own(s.fields, f);

function shown(s: EntityState): Record<string, Json> {
  const f = visibleFields(s);
  delete f[BASE_FIELD];
  return f;
}

const orderOf = (n: LibNode): number => {
  const o = n.fields['o'];
  return typeof o === 'number' ? o : Number.POSITIVE_INFINITY;
};

/** Display order: `o`, then name, then id (code-unit order: the same on every phone). */
export function compareNodes(a: LibNode, b: LibNode): number {
  const oa = orderOf(a);
  const ob = orderOf(b);
  if (oa !== ob) return oa < ob ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function node(kind: typeof LFO | typeof LIT, id: string, s: EntityState): LibNode {
  const fields = shown(s);
  const rm = register(s, 'rm');
  const trashed = fields['rm'] === 1;
  const n: LibNode = {
    kind,
    id,
    fields,
    name: typeof fields['n'] === 'string' ? fields['n'] : '',
    parent: TOP,
    depth: 0,
    trashed,
    inTrash: trashed,
    changed: lastWrite(s)!,
  };
  if (trashed && rm !== undefined) n.trashedAt = rm.stamp;
  if (s.created !== undefined) n.created = s.created;
  return n;
}

/** The library tree of a library group's data view. */
export function libraryView(data: Readonly<TeamData>): LibraryView {
  const root = groupMeta(data).root;
  const folders = new Map<string, LibNode>();
  const items = new Map<string, LibNode>();
  const states = new Map<string, EntityState>();
  /** Folder ids that exist but were purged. */
  const purged = new Set<string>();
  for (const rec of data.entities.values()) {
    if (rec.kind !== LFO && rec.kind !== LIT) continue;
    if (!isLive(rec.state)) {
      if (rec.kind === LFO) purged.add(rec.id);
      continue;
    }
    const n = node(rec.kind, rec.id, rec.state);
    (rec.kind === LFO ? folders : items).set(rec.id, n);
    if (rec.kind === LFO) states.set(rec.id, rec.state);
  }
  const rootFolder = root !== undefined && folders.has(root) ? root : undefined;
  const fallback = rootFolder ?? TOP;
  const repaired = new Map<string, Repair>();
  /** Nodes under a purged folder (in the trash, shown under the root). */
  const underPurged = new Set<string>();

  // 1. Raw parents: a live folder other than itself, else the fallback.
  const parentOf = (n: LibNode): string => {
    if (n.id === root) return TOP;
    const p = n.fields['p'];
    if (typeof p !== 'string' || p === n.id) return fallback;
    if (folders.has(p)) return p;
    if (purged.has(p)) underPurged.add(`${n.kind}:${n.id}`);
    else if (n.kind === LFO) repaired.set(n.id, 'dangling');
    return fallback;
  };
  const folderIds = [...folders.keys()].sort(byId);
  for (const id of folderIds) {
    const f = folders.get(id)!;
    f.parent = parentOf(f);
  }

  // 2. Cycles: each node has one parent, so each cycle is disjoint from the others.
  const done = new Set<string>();
  for (const start of folderIds) {
    const path: string[] = [];
    const onPath = new Map<string, number>();
    let cur: string = start;
    while (cur !== TOP && !done.has(cur) && !onPath.has(cur)) {
      onPath.set(cur, path.length);
      path.push(cur);
      cur = folders.get(cur)!.parent;
    }
    if (cur !== TOP && onPath.has(cur)) {
      const cycle = path.slice(onPath.get(cur)!);
      const pStamp = (id: string): Stamp => register(states.get(id)!, 'p')!.stamp;
      const loser = cycle.reduce((a, b) => {
        const c = compareStamp(pStamp(a), pStamp(b));
        return c < 0 || (c === 0 && a < b) ? a : b;
      });
      folders.get(loser)!.parent = fallback;
      repaired.set(loser, 'cycle');
    }
    for (const id of path) done.add(id);
  }

  // 3. Depth and trash, top-down (breadth first, children in id order).
  const kids = new Map<string, string[]>();
  for (const id of folderIds) {
    const p = folders.get(id)!.parent;
    const list = kids.get(p);
    if (list === undefined) kids.set(p, [id]);
    else list.push(id);
  }
  const queue: string[] = [];
  const enter = (id: string, parent: string, depth: number) => {
    const f = folders.get(id)!;
    f.parent = parent;
    f.depth = depth;
    const up = parent === TOP ? undefined : folders.get(parent);
    f.inTrash = f.trashed || underPurged.has(`${LFO}:${id}`) || up?.inTrash === true;
    queue.push(id);
  };
  for (const id of kids.get(TOP) ?? []) enter(id, TOP, id === rootFolder ? 0 : 1);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    const f = folders.get(id)!;
    for (const child of kids.get(id) ?? []) {
      if (f.depth + 1 > MAX_FOLDER_DEPTH) {
        // Too deep: beside its deepest allowed ancestor (this folder's parent).
        repaired.set(child, 'depth');
        enter(child, f.parent, f.depth);
      } else enter(child, id, f.depth + 1);
    }
  }

  // 4. Items.
  for (const it of items.values()) {
    it.parent = parentOf(it);
    const up = it.parent === TOP ? undefined : folders.get(it.parent);
    it.depth = up === undefined ? (it.id === root ? 0 : 1) : up.depth + 1;
    it.inTrash = it.trashed || underPurged.has(`${LIT}:${it.id}`) || up?.inTrash === true;
  }

  // 5. Children lists (out of the trash only), in display order.
  const children = new Map<string, LibNode[]>();
  const add = (n: LibNode) => {
    if (n.inTrash) return;
    const list = children.get(n.parent);
    if (list === undefined) children.set(n.parent, [n]);
    else list.push(n);
  };
  for (const f of folders.values()) add(f);
  for (const it of items.values()) add(it);
  for (const list of children.values())
    list.sort((a, b) => (a.kind !== b.kind ? (a.kind === LFO ? -1 : 1) : compareNodes(a, b)));

  return { root, folders, items, children, repaired };
}

/** The node behind a record key (`lfo:id` / `lit:id`), if live. */
export function nodeOf(view: LibraryView, kind: string, id: string): LibNode | undefined {
  return kind === LFO ? view.folders.get(id) : kind === LIT ? view.items.get(id) : undefined;
}

/** Whether `ancestor` is `id` or one of its effective ancestors. */
export function isWithin(view: LibraryView, id: string, ancestor: string): boolean {
  let cur: string | undefined = id;
  for (let i = 0; cur !== undefined && cur !== TOP && i <= MAX_FOLDER_DEPTH + 1; i++) {
    if (cur === ancestor) return true;
    cur = view.folders.get(cur)?.parent;
  }
  return false;
}

/** Levels of folders below `id` (0 for a folder with no sub-folder). */
export function subtreeHeight(view: LibraryView, id: string): number {
  let h = 0;
  for (const c of view.children.get(id) ?? [])
    if (c.kind === LFO) h = Math.max(h, 1 + subtreeHeight(view, c.id));
  return h;
}

export type MoveCheck = 'ok' | 'missing' | 'root' | 'trash' | 'cycle' | 'depth';

/**
 * Whether a local move of folder or item `id` under folder `to` is sound (the
 * UI asks before writing; concurrent moves are still repaired by the view).
 */
export function checkMove(view: LibraryView, kind: string, id: string, to: string): MoveCheck {
  const n = nodeOf(view, kind, id);
  const target = view.folders.get(to);
  if (n === undefined || target === undefined) return 'missing';
  if (id === view.root) return 'root';
  if (n.inTrash || target.inTrash) return 'trash';
  if (kind !== LFO) return 'ok';
  if (isWithin(view, to, id)) return 'cycle';
  return target.depth + 1 + subtreeHeight(view, id) > MAX_FOLDER_DEPTH ? 'depth' : 'ok';
}

/** Folders and items under folder `id` (its whole subtree, itself excluded), trash included. */
export function descendants(view: LibraryView, id: string): LibNode[] {
  const out: LibNode[] = [];
  const all = [...view.folders.values(), ...view.items.values()];
  for (const n of all) if (n.id !== id && isWithin(view, n.parent, id)) out.push(n);
  return out.sort((a, b) => (a.kind !== b.kind ? (a.kind === LFO ? -1 : 1) : byId(a.id, b.id)));
}
