import type { Json } from '@core/team/canonical';
import { isLive, visibleFields } from '@core/team/crdt';
import type { TeamData } from '@core/team/data';
import { isShortId, isTeamId } from '@core/team/ids';
import { isAdminRole } from '@core/team/roles';

import { app, flag, has, knownFieldsValid, rewritesOnce, type FieldRule } from './fields';
import { recordKey, type DomainPlugin } from './registry';

/**
 * What a sync group is (2.7.0, `docs/design/sync-layer.md` §3.1): one shared,
 * admin-written record `e.set { k: 'gmeta', id: 'g', f: { app, v, parent?,
 * follow?, net?, root? } }`. No record means `app: 'team'`, so every team
 * made before 2.7.0 is a team. It is encrypted like any data op: only members
 * learn `app` and `parent`. A 2.6 phone stores, relays and skips it.
 *
 * - `app` (`team` | `lib` | `self`…), `parent` (a group id) and `root` (the
 *   shared folder or item id, or `*`) are written once: a later write may
 *   repeat them, never change them (a team must never turn into a library).
 * - `follow` (the folder follows the parent team's members) and `net` are
 *   0/1 flags; `v` is the domain's data version.
 * - Only admins write it, and nobody deletes it.
 * - Unknown fields are accepted (forward-lenient, `fields.ts`).
 *
 * Validators only in 2.7.0 G1: nothing writes it before G5/G10.
 */
export const GMETA = 'gmeta';
/** The id of a group's singleton records (`gmeta`, the team's `net`). */
export const GROUP_RECORD_ID = 'g';
/** The app of a group with no `gmeta`. */
export const DEFAULT_APP = 'team';
/** Fields a later write may repeat but never change. */
export const GMETA_ONCE: readonly string[] = ['app', 'parent', 'root'];

const MAX_DATA_VERSION = 0xffff;

const GMETA_FIELDS: Readonly<Record<string, FieldRule>> = {
  app,
  v: (v) => Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= MAX_DATA_VERSION,
  parent: isTeamId,
  follow: flag,
  net: flag,
  root: (v) => v === '*' || isShortId(v),
};

export function validGroupMetaFields(f: Readonly<Record<string, Json>>): boolean {
  return knownFieldsValid(f, GMETA_FIELDS);
}

export const GMETA_KEY = recordKey(false, GMETA, GROUP_RECORD_ID);

export const groupMetaPlugin: DomainPlugin = {
  id: 'group',
  kinds: [GMETA],
  owned: () => false,
  validate: (w) => w.id === GROUP_RECORD_ID && w.o === undefined,
  authorize(w, role, view) {
    if (w.op === 'del' || !isAdminRole(role)) return 'forbidden';
    if (!validGroupMetaFields(w.f)) return 'invalid';
    const cur = view.entities.get(GMETA_KEY)?.state;
    // The first write says what the group is.
    if (cur === undefined && !has(w.f, 'app')) return 'invalid';
    if (rewritesOnce(cur, w.f, GMETA_ONCE)) return 'forbidden';
    return { owner: undefined };
  },
};

/** What a group's `gmeta` says (defaults for a group without one: a team). */
export interface GroupMeta {
  app: string;
  v: number;
  parent?: string;
  follow: boolean;
  net: boolean;
  root?: string;
}

/** The group's meta as folded (no record, or an unreadable one: a team). */
export function groupMeta(data: Readonly<TeamData>): GroupMeta {
  const rec = data.entities.get(GMETA_KEY);
  const f = rec !== undefined && isLive(rec.state) ? visibleFields(rec.state) : {};
  const out: GroupMeta = {
    app: typeof f['app'] === 'string' ? f['app'] : DEFAULT_APP,
    v: typeof f['v'] === 'number' ? f['v'] : 1,
    follow: f['follow'] === 1,
    net: f['net'] === 1,
  };
  if (typeof f['parent'] === 'string') out.parent = f['parent'];
  if (typeof f['root'] === 'string') out.root = f['root'];
  return out;
}
