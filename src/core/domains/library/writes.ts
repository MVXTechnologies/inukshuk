import type { Json } from '@core/team/canonical';
import { BASE_FIELD, baseFrom, baseToWire, compareWrites, type Write } from '@core/group/conflicts';
import { knownFieldsValid } from '@core/group/fields';

import { historyKey, type LibraryHistory, type LibWrite } from './history';
import {
  CURSOR_ID,
  ITEM_TYPES,
  LAC,
  LCM,
  LFO,
  LIT,
  MAX_INLINE_BODY,
  SPECS,
  type ItemType,
} from './kinds';

/**
 * Bodies of the library ops this phone writes (the bridge signs and sends
 * them, G10). Every edit of an existing folder or item carries the base of
 * what this phone had folded (`@core/group/conflicts`), so the others can
 * tell a conflict from a correction.
 */

export interface SetBody {
  k: string;
  id: string;
  f: Record<string, Json>;
}

export interface DelBody {
  k: string;
  id: string;
  o?: string;
}

/** Whether `f` passes the kind's field rules (what the fold will check). */
export function validFields(kind: string, f: Readonly<Record<string, Json>>): boolean {
  const spec = SPECS.get(kind);
  return spec !== undefined && Object.keys(f).length > 0 && knownFieldsValid(f, spec.rules);
}

/**
 * Whether a body fits one op once encrypted (UTF-8 bytes of its JSON). A
 * track or area that does not goes as a blob (2.7.1); until then it is shown
 * to others as "not shared yet".
 */
export function fitsInline(body: SetBody): boolean {
  return new TextEncoder().encode(JSON.stringify(body)).length <= MAX_INLINE_BODY;
}

export function newFolder(
  id: string,
  name: string,
  parent?: string,
  extra: Record<string, Json> = {},
): SetBody {
  const f: Record<string, Json> = { ...extra, n: name };
  if (parent !== undefined) f['p'] = parent;
  return { k: LFO, id, f };
}

export function newItem(
  id: string,
  type: ItemType,
  name: string,
  parent?: string,
  extra: Record<string, Json> = {},
): SetBody {
  if (!ITEM_TYPES.includes(type)) throw new Error(`unknown item type '${type}'`);
  const f: Record<string, Json> = { ...extra, t: type, n: name };
  if (parent !== undefined) f['p'] = parent;
  return { k: LIT, id, f };
}

const writesOf = (h: LibraryHistory, kind: string, id: string): readonly LibWrite[] =>
  h.records.get(historyKey(kind, id)) ?? [];

/** An edit of an existing folder or item by `me`, with its base. */
export function edit(
  h: LibraryHistory,
  me: string,
  kind: typeof LFO | typeof LIT,
  id: string,
  fields: Record<string, Json>,
): SetBody {
  const f: Record<string, Json> = { ...fields };
  delete f[BASE_FIELD];
  const base = baseFrom(writesOf(h, kind, id), me);
  if (base.size > 0) f[BASE_FIELD] = baseToWire(base);
  return { k: kind, id, f };
}

/** Soft delete: into the trash, fields kept. */
export const trash = (h: LibraryHistory, me: string, kind: typeof LFO | typeof LIT, id: string) =>
  edit(h, me, kind, id, { rm: 1 });

/** Out of the trash, with whatever was edited meanwhile. */
export const restore = (h: LibraryHistory, me: string, kind: typeof LFO | typeof LIT, id: string) =>
  edit(h, me, kind, id, { rm: 0 });

/** "Use this": the other version of a conflicted field becomes a new edit everyone gets. */
export const useVersion = (
  h: LibraryHistory,
  me: string,
  kind: typeof LFO | typeof LIT,
  id: string,
  field: string,
  value: Json,
) => edit(h, me, kind, id, { [field]: value });

/**
 * Restore after a delete beat offline edits: back out of the trash, and the
 * beaten edits' values written again (newest per field), so they win even
 * if something newer touched those fields while the record was in the trash.
 */
export function restoreWithEdits(
  h: LibraryHistory,
  me: string,
  kind: typeof LFO | typeof LIT,
  id: string,
  edits: readonly Write[],
): SetBody {
  const f: Record<string, Json> = {};
  for (const e of [...edits].sort(compareWrites))
    for (const [k, v] of Object.entries(e.fields)) f[k] = v;
  f['rm'] = 0;
  return edit(h, me, kind, id, f);
}

/** A manager's purge of a record in the trash (final). */
export const purge = (kind: typeof LFO | typeof LIT, id: string): DelBody => ({ k: kind, id });

/** "Restore all" after a mass delete: one restore per record still in the trash. */
export function restoreAll(
  h: LibraryHistory,
  me: string,
  records: readonly { kind: typeof LFO | typeof LIT; id: string }[],
): SetBody[] {
  return records.map((r) => restore(h, me, r.kind, r.id));
}

/** My activity cursor: reviewed up to `seen` (ms). */
export const setCursor = (seen: number): SetBody => ({ k: LAC, id: CURSOR_ID, f: { seen } });

/** A comment on a folder or item (viewers too). */
export const comment = (id: string, on: string, tx: string): SetBody => ({
  k: LCM,
  id,
  f: { on, tx },
});
