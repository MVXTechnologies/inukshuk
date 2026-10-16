import type { Json } from '@core/team/canonical';
import { isLive, visibleFields } from '@core/team/crdt';
import {
  ENTITY_KINDS,
  entityKey,
  GUEST_KINDS,
  OWNED_KINDS,
  OWNER_REF_KINDS,
  type EntityKind,
  type TeamData,
} from '@core/team/data';
import {
  authorizeRecord,
  RECORD_KINDS,
  reindex,
  type RecordKind,
  vertexTrail,
} from '@core/team/records';
import { isAdminRole, type Role } from '@core/team/roles';
import { isTaskStatusUpdate, validTaskFields } from '@core/team/tasks';
import { groupPlugin } from '@core/group/meta';
import {
  DomainRegistry,
  type Authorization,
  type DomainPlugin,
  type KindWrite,
  type Lane,
} from '@core/group/registry';

import { TEAM_V27, TEAM_V27_KINDS } from './groupKinds';
import { authorizeNote, NOTE_KINDS, noteLane, reindexNote, validNoteWrite } from './notes';

/**
 * The team domain (plug-in #1 of the sync-group seam, 2.7.0 PR G1;
 * `docs/design/sync-layer.md` §5.2).
 *
 * Its 2.6 kinds keep the exact rules they had in the fold's switch
 * (`data.ts` before the seam): the same parsers, `records.ts` and
 * `tasks.ts` rules, called in the same order with the same skip reasons. The
 * golden refold test (`index.test.ts`) pins that over a recorded log, the
 * frozen 2.6.1 fold and seeded random workloads.
 *
 * 2.7.0 adds one kind a 2.6 phone stores, relays and skips (`groupKinds.ts`):
 * `gref` (a child group announced in the team). Validators only: no phone
 * writes it before G10. `gmeta`, `irdv` and `net` belong to every group
 * (`@core/group/meta`), registered next to this plug-in by {@link teamRegistry}.
 *
 * 2.7.0 PR G8 adds the notes' two (`notes.ts`, #706): `pnm` (a pin shown as a
 * note: colour, fade, edits) and `pnr` (a "seen" receipt), both owned.
 */
export const TEAM_DOMAIN = 'team';

/** The team kinds a 2.6.1 phone knows. */
export const TEAM_KINDS_V26: readonly string[] = ENTITY_KINDS;

/** Kinds whose counters the record index keeps (`records.ts` `reindex`). */
const INDEXED: readonly string[] = ['trl', 'tve', 'sos', 'drw'];

const isTeamKind = (k: string): k is EntityKind => (ENTITY_KINDS as readonly string[]).includes(k);
const isNoteKind = (k: string): boolean => NOTE_KINDS.includes(k);

/** Alerts go first on every link (§4.4); the rest is live traffic. */
const URGENT: readonly string[] = ['sos', 'rly'];

/** Authorization of a 2.6 `e.set`: the old fold's branches, in order. */
function authorizeSet(
  w: KindWrite,
  kind: EntityKind,
  role: Role,
  view: Readonly<TeamData>,
): Authorization {
  // Guests write comments (and their own alerts, caps, receipts) only.
  if (role === 'guest' && !GUEST_KINDS.includes(kind)) return 'forbidden';
  const f = w.f as Record<string, Json>;
  if (kind === 'task') {
    if (!validTaskFields(f, w.author)) return 'invalid';
    const owner = w.o ?? w.author;
    if (owner !== w.author) {
      // Someone else's task: it must exist (nobody, admins included, creates a
      // task in another member's name); then an admin writes any field, the
      // current assignee only the status.
      const cur = view.entities.get(entityKey('task', w.id, owner));
      if (cur === undefined || !isLive(cur.state)) return 'forbidden';
      const assignee = visibleFields(cur.state)['assignee'];
      if (!isAdminRole(role) && (assignee !== w.author || !isTaskStatusUpdate(f)))
        return 'forbidden';
    }
    return { owner };
  }
  if ((RECORD_KINDS as readonly string[]).includes(kind)) {
    return authorizeRecord(
      { kind: kind as RecordKind, id: w.id, o: w.o, f, author: w.author, role },
      (k, id, o) => view.entities.get(entityKey(k as EntityKind, id, o)),
      view.index,
      w.wall,
    );
  }
  return { owner: OWNED_KINDS.includes(kind) ? w.author : undefined };
}

/** Authorization of a 2.6 `e.del`: the old fold's branches, in order. */
function authorizeDelete(
  w: KindWrite,
  kind: EntityKind,
  role: Role,
  view: Readonly<TeamData>,
): Authorization {
  const owned = OWNED_KINDS.includes(kind);
  const owner = owned ? (w.o ?? w.author) : undefined;
  if (role === 'guest' && !GUEST_KINDS.includes(kind)) return 'forbidden';
  // A resolution is reopened (res: false), never deleted.
  if (kind === 'mres') return 'forbidden';
  // Trail vertices: any member deletes one of a live trail (`o` = its owner).
  const vertex =
    kind === 'tve' &&
    owner !== undefined &&
    (() => {
      const tr = vertexTrail(w.id);
      const t = tr === null ? undefined : view.entities.get(entityKey('trl', tr, owner));
      return t !== undefined && isLive(t.state);
    })();
  if (kind === 'tve' && !vertex) return 'forbidden';
  if (owned && owner !== w.author && !isAdminRole(role) && !vertex) return 'forbidden';
  return { owner };
}

export const teamPlugin: DomainPlugin<TeamData> = {
  id: TEAM_DOMAIN,
  kinds: [...ENTITY_KINDS, ...TEAM_V27_KINDS, ...NOTE_KINDS],
  threads: ['team', 'dm', 'g', 'photo', 'task', 'pin', 'trail'],
  ephemeral: ['pos', 'pen'],
  needsCaps: ['pen'],
  owned: (kind) =>
    isTeamKind(kind) ? OWNED_KINDS.includes(kind) : isNoteKind(kind) || TEAM_V27.owned(kind),
  validate(w) {
    if (TEAM_V27.has(w.kind)) return TEAM_V27.validate(w);
    if (isNoteKind(w.kind)) return validNoteWrite(w);
    // A message is a `msg` op, never an `e.set`; only some kinds name another's record.
    if (w.op === 'del') return true;
    return w.kind !== 'msg' && (w.o === undefined || OWNER_REF_KINDS.includes(w.kind));
  },
  authorize(w, role, view) {
    if (TEAM_V27.has(w.kind)) return TEAM_V27.authorize(w, role, view);
    if (isNoteKind(w.kind)) return authorizeNote(w, role, view);
    // Registered kinds only reach here: the team's own.
    const kind = w.kind as EntityKind;
    return w.op === 'set'
      ? authorizeSet(w, kind, role, view)
      : authorizeDelete(w, kind, role, view);
  },
  merged(view, rec, before) {
    if (INDEXED.includes(rec.kind)) reindex(view.index, rec, before);
    else if (isNoteKind(rec.kind)) reindexNote(view, rec);
  },
  lane: (kind): Lane => (URGENT.includes(kind) ? 0 : isNoteKind(kind) ? noteLane(kind) : 1),
};

let shared: DomainRegistry | undefined;

/** The registry of a team group (the group meta kind + the team domain), frozen and shared. */
export function teamRegistry(): DomainRegistry {
  shared ??= new DomainRegistry([groupPlugin, teamPlugin]).freeze();
  return shared;
}
