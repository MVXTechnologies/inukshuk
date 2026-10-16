import { canonicalize, type Json } from '@core/team/canonical';
import { isShortId } from '@core/team/ids';

import { LFO, LIT } from './kinds';
import { localKindOf, representable, type LocalKind } from './liveFields';
import type { LibNode, LibraryView } from './tree';

/**
 * The two-way reconcile between one shared folder (or item) and this phone's
 * Library (2.7.0 #712, design §5.3 "library bridge"). Pure: the data layer
 * reads the Library's in-scope items as record fields, folds the group, and
 * carries out the plan.
 *
 * It is a three-way merge per record against the **base**: what both sides
 * last agreed on, field by field (kept on this phone with the link table).
 * - a field changed here and not there: written to the group;
 * - changed there and not here: applied to the Library (origin "sync", so it
 *   never echoes: the base moves with it);
 * - changed on both: written to the group, whose LWW and conflict view
 *   decide (Activity lists it);
 * - an item gone from the Library (deleted, or moved out of the folder): put
 *   in the group's trash;
 * - an item gone from the group (in its trash, purged): deleted here;
 * - new on either side: created on the other.
 *
 * **Placement** is a field like the others: `p`, the parent folder's record
 * id, compared through the link table (a Library folder's id on this side,
 * its record's on the other), so sub-folders and moves between them travel
 * both ways. The view's effective parent is used for the group side (cycles
 * and depth already repaired there, the same on every phone).
 *
 * Idempotent: a second run over its own result plans nothing.
 */

export type RecordKind = typeof LFO | typeof LIT;

/** One Library item in the share's scope, as record fields (no `p`, `rm`, `b`). */
export interface LocalRecord {
  kind: LocalKind;
  id: string;
  fields: Record<string, Json>;
  /** Its Library folder (absent: the share's root folder, or none for a single item). */
  parent?: string;
}

/** A record linked to a Library item, with the fields both last agreed on (hashed). */
export interface Link {
  rid: string;
  kind: RecordKind;
  local: string;
  localKind: LocalKind;
  base: Record<string, string>;
  /** The record was seen live in the group (until then, a missing record is re-written, not a delete). */
  seen?: boolean;
}

export type PlannedWrite =
  | { op: 'new'; kind: RecordKind; rid: string; fields: Record<string, Json> }
  | { op: 'edit'; kind: RecordKind; rid: string; fields: Record<string, Json> }
  | { op: 'trash'; kind: RecordKind; rid: string };

export type LocalOp =
  | {
      op: 'create';
      kind: LocalKind;
      local: string;
      rid: string;
      fields: Record<string, Json>;
      /** Its Library folder (absent: none, a single shared item). */
      parent?: string;
    }
  | {
      op: 'update';
      kind: LocalKind;
      local: string;
      /** The record's fields after the update (all of them, not only the changed ones). */
      fields: Record<string, Json>;
      changed: string[];
      /** Its Library folder when the move came with it (`changed` has `p`). */
      parent?: string;
    }
  | { op: 'delete'; kind: LocalKind; local: string };

export interface BridgePlan {
  writes: PlannedWrite[];
  local: LocalOp[];
  links: Link[];
  /** Live remote items this phone cannot hold yet (a map to download, a trail without geometry). */
  waiting: string[];
}

export interface ReconcileInput {
  /** The share's root: a folder (`lfo`) or a single item (`lit`). */
  root: { kind: RecordKind; rid: string };
  /**
   * The Library item the root is (a folder, or the single shared item);
   * absent on a phone that joined until the root arrives (then the link names it).
   */
  rootLocal?: { kind: LocalKind; id: string };
  /** The Library's root item and the items in the root folder. */
  local: readonly LocalRecord[];
  view: LibraryView;
  links: readonly Link[];
  /** A fresh Library id for a record arriving here (the record id when free). */
  newLocalId(rid: string, kind: LocalKind): string;
  /** A fresh record id for an item new here (its Library id when usable). */
  newRecordId(local: LocalRecord): string;
  /**
   * Whether this phone can hold a live item now (a trail with all its parts
   * in, say). Default: what its fields alone allow (`representable`).
   */
  holdable?(node: LibNode): boolean;
}

/** Fields the bridge never compares (placement and trash are the bridge's own). */
const SKIP = new Set(['rm', 'b', 'o']);

const FNV_OFFSET = 0x811c9dc5;
function fnv(s: string): string {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** A field value's fingerprint (long values hashed, so the link table stays small). */
export function fingerprint(v: Json | undefined): string {
  if (v === undefined) return '';
  const c = canonicalize(v) ?? '';
  return c.length <= 64 ? c : `#${c.length}:${fnv(c)}`;
}

function baseOf(fields: Readonly<Record<string, Json>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) if (!SKIP.has(k)) out[k] = fingerprint(v);
  return out;
}

function compared(fields: Readonly<Record<string, Json>>): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(fields)) if (!SKIP.has(k)) out[k] = v;
  return out;
}

const recordKindOf = (k: LocalKind): RecordKind => (k === 'folder' ? LFO : LIT);
const localKey = (kind: LocalKind, id: string) => `${kind}:${id}`;

/** Fields whose fingerprint differs from the base (a field gone counts when it was there). */
function changedFrom(
  fields: Readonly<Record<string, Json>>,
  base: Record<string, string>,
): string[] {
  const keys = new Set([...Object.keys(fields), ...Object.keys(base)]);
  const out: string[] = [];
  for (const k of keys) {
    if (SKIP.has(k)) continue;
    if (fingerprint(fields[k]) !== (base[k] ?? '')) out.push(k);
  }
  return out.sort();
}

function nodeOf(view: LibraryView, kind: RecordKind, rid: string): LibNode | undefined {
  return kind === LFO ? view.folders.get(rid) : view.items.get(rid);
}

/** The node is live and out of the trash. */
const alive = (n: LibNode | undefined): n is LibNode => n !== undefined && !n.inTrash;

/** Remote records in the share's scope: the root, its folders (shallow first), then items. */
function remoteScope(view: LibraryView, root: ReconcileInput['root']): LibNode[] {
  const out: LibNode[] = [];
  const r = nodeOf(view, root.kind, root.rid);
  if (alive(r)) out.push(r);
  if (root.kind !== LFO) return out;
  const folders = [...view.folders.values()]
    .filter((f) => alive(f) && f.id !== root.rid)
    .sort((a, b) => a.depth - b.depth || (a.id < b.id ? -1 : 1));
  out.push(...folders);
  for (const it of view.items.values()) if (alive(it)) out.push(it);
  return out;
}

export function reconcile(input: ReconcileInput): BridgePlan {
  const { root, view } = input;
  const writes: PlannedWrite[] = [];
  const local: LocalOp[] = [];
  const links: Link[] = [];
  const waiting: string[] = [];
  const holdable = (n: LibNode) => input.holdable?.(n) ?? representable(n.fields);
  const locals = new Map(input.local.map((l) => [localKey(l.kind, l.id), l]));
  const linkedLocal = new Set<string>();
  const linkedRid = new Set<string>();
  const usedRids = new Set<string>([...view.folders.keys(), ...view.items.keys()]);
  /** Library folder id ⇄ record id, for placement. */
  const ridOfFolder = new Map<string, string>();
  const folderOfRid = new Map<string, string>();
  const pair = (localFolder: string, rid: string) => {
    ridOfFolder.set(localFolder, rid);
    folderOfRid.set(rid, localFolder);
  };
  for (const l of input.links) if (l.localKind === 'folder') pair(l.local, l.rid);
  const rootLocal = input.rootLocal;
  if (rootLocal?.kind === 'folder') pair(rootLocal.id, root.rid);
  const isRootLocal = (l: { kind: LocalKind; id: string }) =>
    l.kind === rootLocal?.kind && l.id === rootLocal.id;
  const linkByLocal = new Map(input.links.map((l) => [localKey(l.localKind, l.local), l]));

  // A catalog map downloaded into the folder joins the record that named it.
  const linkedRids = new Set(input.links.map((l) => l.rid));
  const remoteAll = remoteScope(view, root);
  const matched = new Map<string, LibNode>();
  for (const l of input.local) {
    if (linkByLocal.has(localKey(l.kind, l.id))) continue;
    if (l.kind !== 'map' || typeof l.fields['cat'] !== 'string') continue;
    const r = remoteAll.find(
      (n) =>
        !linkedRids.has(n.id) &&
        ![...matched.values()].includes(n) &&
        n.fields['cat'] === l.fields['cat'],
    );
    if (r !== undefined) matched.set(localKey(l.kind, l.id), r);
  }

  // Record ids for what is new here, decided up front (a new folder's items name it).
  const newRid = new Map<string, string>();
  for (const l of input.local) {
    const key = localKey(l.kind, l.id);
    if (linkByLocal.has(key) || matched.has(key)) continue;
    let rid: string;
    if (isRootLocal(l)) rid = root.rid;
    else {
      rid = input.newRecordId(l);
      if (!isShortId(rid) || usedRids.has(rid) || linkedRids.has(rid)) continue;
    }
    usedRids.add(rid);
    newRid.set(key, rid);
    if (l.kind === 'folder') pair(l.id, rid);
  }

  /** The record fields of a Library item, with its placement as a record id. */
  const withPlace = (l: LocalRecord): Record<string, Json> => {
    const f = compared(l.fields);
    delete f['p'];
    if (isRootLocal(l) || root.kind !== LFO) return f;
    const parent = l.parent ?? rootLocal?.id;
    const rid = parent === undefined ? undefined : ridOfFolder.get(parent);
    f['p'] = rid ?? root.rid;
    return f;
  };
  /** The group's fields of a node, with its effective placement. */
  const remoteFields = (n: LibNode): Record<string, Json> => {
    const f = compared(n.fields);
    delete f['p'];
    if (n.id !== root.rid && root.kind === LFO && n.parent !== '') f['p'] = n.parent;
    return f;
  };
  const localParent = (rid: Json | undefined): string | undefined =>
    typeof rid === 'string' ? (folderOfRid.get(rid) ?? rootLocal?.id) : undefined;

  for (const link of input.links) {
    const key = localKey(link.localKind, link.local);
    const l = locals.get(key);
    const r = nodeOf(view, link.kind, link.rid);
    const isRoot = link.rid === root.rid;
    // Handled here whatever happens (a record just trashed is not "new there").
    linkedRid.add(link.rid);
    if (l === undefined) {
      // Gone from the Library (or out of the folder): into the group's trash.
      if (alive(r) && !isRoot) writes.push({ op: 'trash', kind: link.kind, rid: link.rid });
      if (isRoot) links.push(link);
      continue;
    }
    if (!alive(r)) {
      if (r === undefined && link.seen !== true) {
        // Our create never landed (a key rotation was pending): write it again.
        const fields = withPlace(l);
        writes.push({ op: 'new', kind: link.kind, rid: link.rid, fields });
        links.push({ ...link, base: baseOf(fields) });
        linkedLocal.add(key);
        continue;
      }
      // In the group's trash or purged: gone here too (the root is never trashed).
      if (!isRoot) local.push({ op: 'delete', kind: link.localKind, local: link.local });
      else {
        links.push(link);
        linkedLocal.add(key);
      }
      continue;
    }
    linkedLocal.add(key);
    const lf = withPlace(l);
    const rf = remoteFields(r);
    const mine = changedFrom(lf, link.base);
    // A change there this phone cannot hold yet (a trail's parts still coming) waits.
    const ready = r.kind === LFO || holdable(r);
    const theirs = ready ? changedFrom(rf, link.base).filter((k) => !mine.includes(k)) : [];
    const base = { ...link.base };
    const out: Record<string, Json> = {};
    for (const k of mine) {
      const v = lf[k];
      // A field cleared here: a description becomes empty; others cannot be unset.
      if (v === undefined) {
        if (k === 'd' && rf['d'] !== undefined && rf['d'] !== '') out['d'] = '';
        base[k] = fingerprint(rf[k]);
        continue;
      }
      if (k === 't') {
        base[k] = fingerprint(rf[k]);
        continue;
      }
      if (fingerprint(v) === fingerprint(rf[k])) {
        base[k] = fingerprint(v);
        continue;
      }
      out[k] = v;
      base[k] = fingerprint(v);
    }
    if (Object.keys(out).length > 0)
      writes.push({ op: 'edit', kind: link.kind, rid: link.rid, fields: out });
    if (theirs.length > 0) {
      const next: Record<string, Json> = { ...lf };
      for (const k of theirs) {
        const v = rf[k];
        if (v === undefined) delete next[k];
        else next[k] = v;
        base[k] = fingerprint(v);
      }
      const op: LocalOp = {
        op: 'update',
        kind: link.localKind,
        local: link.local,
        fields: next,
        changed: theirs,
      };
      if (theirs.includes('p')) {
        const parent = localParent(rf['p']);
        if (parent !== undefined) op.parent = parent;
      }
      local.push(op);
    }
    links.push({ ...link, base, seen: true });
  }

  for (const [key, r] of matched) {
    const [, id] = key.split(/:(.*)/) as [string, string];
    linkedLocal.add(key);
    linkedRid.add(r.id);
    links.push({
      rid: r.id,
      kind: LIT,
      local: id,
      localKind: 'map',
      base: baseOf(remoteFields(r)),
      seen: true,
    });
  }

  // New here: written to the group (folders first: their items name them).
  const fresh = input.local
    .filter((l) => newRid.has(localKey(l.kind, l.id)))
    .sort((a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder'));
  for (const l of fresh) {
    const key = localKey(l.kind, l.id);
    const rid = newRid.get(key)!;
    const kind = recordKindOf(l.kind);
    linkedRid.add(rid);
    const fields = withPlace(l);
    const r = nodeOf(view, kind, rid);
    if (alive(r)) {
      // The root record exists already (a phone re-linking after a restart): agree on it next run.
      links.push({
        rid,
        kind,
        local: l.id,
        localKind: l.kind,
        base: baseOf(remoteFields(r)),
        seen: true,
      });
      continue;
    }
    writes.push({ op: 'new', kind, rid, fields });
    links.push({ rid, kind, local: l.id, localKind: l.kind, base: baseOf(fields) });
  }

  // New there: created here when this phone can hold it (folders first, shallow first).
  for (const r of remoteAll) {
    if (linkedRid.has(r.id)) continue;
    const lk: LocalKind | undefined = r.kind === LFO ? 'folder' : localKindOf(r.fields);
    if (lk === undefined) continue;
    if (lk !== 'folder' && !holdable(r)) {
      waiting.push(r.id);
      continue;
    }
    const id = input.newLocalId(r.id, lk);
    const fields = remoteFields(r);
    const op: LocalOp = { op: 'create', kind: lk, local: id, rid: r.id, fields };
    const parent = localParent(fields['p']);
    if (parent !== undefined) op.parent = parent;
    local.push(op);
    if (lk === 'folder') {
      if (r.id === root.rid) pair(id, r.id);
      else pair(id, r.id);
    }
    links.push({
      rid: r.id,
      kind: r.kind,
      local: id,
      localKind: lk,
      base: baseOf(fields),
      seen: true,
    });
  }

  return { writes, local, links, waiting: waiting.sort() };
}
