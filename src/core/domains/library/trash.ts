import type { Stamp } from '@core/team/hlc';

import { LFO, TRASH_MS } from './kinds';
import { descendants, type LibNode, type LibraryView } from './tree';

/**
 * The 30-day trash (R-LIB-1, design §4.2). A soft delete keeps the record's
 * fields in the replicated state, so every phone can restore it; the trash
 * lists what was put there in the last {@link TRASH_MS}, top-most first (a
 * trashed folder stands for its contents). Older entries leave the list: the
 * phone may drop their blobs and a manager may purge them.
 */
export interface TrashEntry {
  node: LibNode;
  /** When it went to the trash (its `rm` write, else its newest write: under a purged folder). */
  since: Stamp;
  /** When this phone stops listing it. */
  expiresAt: number;
  /** Folders: how many folders and items went with it. */
  contents: number;
}

/** Top-most trash nodes: in the trash, but their parent is not. */
function tops(view: LibraryView): LibNode[] {
  const out: LibNode[] = [];
  for (const n of [...view.folders.values(), ...view.items.values()]) {
    if (!n.inTrash) continue;
    const up = view.folders.get(n.parent);
    if (up === undefined || !up.inTrash) out.push(n);
  }
  return out;
}

function entry(view: LibraryView, n: LibNode): TrashEntry {
  const since = n.trashedAt ?? n.changed;
  return {
    node: n,
    since,
    expiresAt: since.wall + TRASH_MS,
    contents: n.kind === LFO ? descendants(view, n.id).length : 0,
  };
}

const newestFirst = (a: TrashEntry, b: TrashEntry) =>
  b.since.wall - a.since.wall || (a.node.id < b.node.id ? -1 : 1);

/** The trash as listed now (newest first). */
export function trashList(view: LibraryView, now: number): TrashEntry[] {
  return tops(view)
    .map((n) => entry(view, n))
    .filter((e) => e.expiresAt > now)
    .sort(newestFirst);
}

/** Trash entries past {@link TRASH_MS}: blobs may go, a manager's sweep may purge them. */
export function expiredTrash(view: LibraryView, now: number): TrashEntry[] {
  return tops(view)
    .map((n) => entry(view, n))
    .filter((e) => e.expiresAt <= now)
    .sort(newestFirst);
}

/**
 * The records a soft delete of `node` takes into the trash: itself and its
 * contents not trashed on their own (directly or by a folder in between).
 * The same before and after the delete is folded: what a mass-delete count
 * weighs, and what "Restore all" brings back.
 */
export function trashedBy(view: LibraryView, node: LibNode): LibNode[] {
  if (node.kind !== LFO) return [node];
  const own = (d: LibNode): boolean => {
    if (d.trashed) return false;
    for (let up = view.folders.get(d.parent); up !== undefined && up.id !== node.id;) {
      if (up.trashed) return false;
      up = view.folders.get(up.parent);
    }
    return true;
  };
  return [node, ...descendants(view, node.id).filter(own)];
}
