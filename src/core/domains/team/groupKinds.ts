import { fromB64uLen } from '@core/team/bytes';
import { KEY_BYTES } from '@core/team/crypto';
import type { TeamData } from '@core/team/data';
import { isMemberId, isTeamId } from '@core/team/ids';
import { isAdminRole, type Role } from '@core/team/roles';
import {
  app,
  flag,
  has,
  knownFieldsValid,
  rewritesOnce,
  text,
  type FieldRule,
} from '@core/group/fields';
import { GROUP_RECORD_ID } from '@core/group/meta';
import { recordKey, type Authorization, type KindWrite } from '@core/group/registry';

/**
 * The team domain's 2.7.0 kinds (`docs/design/sync-layer.md` §3.4, §5.2;
 * security review §2.2). Each is an unknown kind to a 2.6 phone, which
 * stores, relays and skips it. Forward-lenient on unknown fields
 * (`@core/group/fields`). Validators only in G1: nothing writes them yet.
 *
 * | kind | key | fields | who writes | who deletes |
 * |---|---|---|---|---|
 * | `gref` a child group (a folder shared with the team) | owned, id = the child group id | `app` (first write, then never changed), `name` | members | its writer or an admin |
 * | `irdv` an invite's internet rendezvous | owned, id = the invite id | `s` = `ir`, 32 bytes (first write) | admins (who create invites) | its writer or an admin |
 * | `net` the team's internet switch | shared, id `g` | `inet` 0/1 (first write) | admins | admins |
 */
export const GREF = 'gref';
export const IRDV = 'irdv';
export const NET = 'net';
export const TEAM_V27_KINDS: readonly string[] = [GREF, IRDV, NET];

export const MAX_GROUP_NAME = 80;

interface Spec {
  owned: boolean;
  /** Who may write it (deletes: see {@link authorizeTeamV27Kind}). */
  writes: (role: Role) => boolean;
  /** Checks of the write's id. */
  id: (id: string) => boolean;
  rules: Readonly<Record<string, FieldRule>>;
  /** The field its first write must carry. */
  first: string;
  /** Fields a later write may repeat, never change. */
  once: readonly string[];
}

const SPECS: ReadonlyMap<string, Spec> = new Map<string, Spec>([
  [
    GREF,
    {
      owned: true,
      writes: (r) => r !== 'guest',
      id: isTeamId,
      rules: { app, name: text(MAX_GROUP_NAME) },
      first: 'app',
      once: ['app'],
    },
  ],
  [
    IRDV,
    {
      owned: true,
      writes: isAdminRole,
      id: isMemberId,
      rules: { s: (v) => fromB64uLen(v, KEY_BYTES) !== undefined },
      first: 's',
      once: [],
    },
  ],
  [
    NET,
    {
      owned: false,
      writes: isAdminRole,
      id: (id) => id === GROUP_RECORD_ID,
      rules: { inet: flag },
      first: 'inet',
      once: [],
    },
  ],
]);

export const isTeamV27Kind = (kind: string): boolean => SPECS.has(kind);
export const ownedTeamV27Kind = (kind: string): boolean => SPECS.get(kind)?.owned === true;

/** Shape of the write itself, before any role: its id, and `o` only on an owned kind's delete. */
export function validTeamV27Write(w: KindWrite): boolean {
  const spec = SPECS.get(w.kind);
  if (spec === undefined || !spec.id(w.id)) return false;
  return w.o === undefined || (w.op === 'del' && spec.owned);
}

/** Authorization of a write of a {@link TEAM_V27_KINDS} kind validated by {@link validTeamV27Write}. */
export function authorizeTeamV27Kind(
  w: KindWrite,
  role: Role,
  view: Readonly<TeamData>,
): Authorization {
  const spec = SPECS.get(w.kind);
  if (spec === undefined) return 'invalid';
  const admin = isAdminRole(role);
  if (w.op === 'del') {
    if (!spec.owned) return admin ? { owner: undefined } : 'forbidden';
    const owner = w.o ?? w.author;
    return owner === w.author || admin ? { owner } : 'forbidden';
  }
  if (!spec.writes(role)) return 'forbidden';
  if (!knownFieldsValid(w.f, spec.rules)) return 'invalid';
  const owner = spec.owned ? w.author : undefined;
  const cur = view.entities.get(recordKey(spec.owned, w.kind, w.id, owner))?.state;
  if (cur === undefined && !has(w.f, spec.first)) return 'invalid';
  if (rewritesOnce(cur, w.f, spec.once)) return 'forbidden';
  return { owner };
}
