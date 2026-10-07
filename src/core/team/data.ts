import { isRecord, type Json } from './canonical';
import {
  deleteOp,
  dict,
  isLive,
  mergeEntity,
  mergeRegister,
  setOp,
  type EntityState,
  type Register,
  visibleFields,
} from './crdt';
import type { SignedOp } from './envelope';
import { isMemberId, isShortId } from './ids';
import type { TeamState } from './membership';
import { isAdminRole, parseAudience, type Audience } from './roles';
import { isTaskStatusUpdate, validTaskFields } from './tasks';

/**
 * Team data, reduced from the valid data ops of a resolved team (#589).
 *
 * | kind | owned? | who writes | who deletes |
 * |---|---|---|---|
 * | `wpt`, `point` | shared | any member | any member |
 * | `task` | owned | the creator; its assignee only `done`/`dby`/`dat`; admins | creator or an admin |
 * | `track`, `photo` | owned | the creator only | creator or an admin |
 * | `comment` | owned | the creator only (guests too) | creator or an admin |
 * | `msg` (from `msg` ops) | owned, immutable | the creator, once (guests too) | creator or admin (redact) |
 *
 * Guests write only comments: `msg` ops and `comment` entities (their own).
 * A geo-anchored comment ("pin") is a message on the thread `pin:<its id>`
 * carrying `ll = [lng, lat]`; replies are plain messages on that thread.
 *
 * **Owned** kinds are keyed by `(kind, owner, id)`: the owner is part of the
 * key, so nobody can take over a comment by backdating a write to its id —
 * they would just create their own record. Positions are one LWW register
 * per member, only writable by that member.
 *
 * Everything here is a fold in the team's total order over CRDT merges, so the
 * result is a function of the op set alone.
 */
export const ENTITY_KINDS = ['wpt', 'point', 'task', 'track', 'photo', 'comment', 'msg'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];
export const OWNED_KINDS: readonly EntityKind[] = ['task', 'track', 'photo', 'comment', 'msg'];
/** Entity kinds a guest may write (their own records only). */
export const GUEST_KINDS: readonly EntityKind[] = ['comment'];

export const MAX_FIELDS = 64;
export const MAX_MESSAGE_CHARS = 4000;
export const MAX_MENTIONS = 32;
const FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;

const isKind = (v: unknown): v is EntityKind =>
  typeof v === 'string' && (ENTITY_KINDS as readonly string[]).includes(v);

export function entityKey(kind: EntityKind, id: string, owner?: string): string {
  return OWNED_KINDS.includes(kind) ? `${kind}:${owner ?? ''}:${id}` : `${kind}:${id}`;
}

export interface SetBody {
  k: Exclude<EntityKind, 'msg'>;
  id: string;
  f: Record<string, Json>;
  /** Owner of the task being updated by its assignee or an admin (tasks only). */
  o?: string;
}
export interface DelBody {
  k: EntityKind;
  id: string;
  /** Owner of an owned record (defaults to the deleting author). */
  o?: string;
}
export interface MsgBody {
  id: string;
  /** `team`, `dm:<memberId>`, `photo:<id>`, `task:<id>`, `g:<groupId>`… */
  th: string;
  tx: string;
  mn?: string[];
  /** A pin's anchor, `[lng, lat]`: only on the thread `pin:<id>` of its own id. */
  ll?: [number, number];
}
export interface PosBody {
  la: number;
  lo: number;
  /** Horizontal accuracy, m. */
  ac?: number;
  el?: number;
  /** Fix time, epoch ms. */
  at: number;
}

const only = (r: Record<string, unknown>, keys: string[]) =>
  Object.keys(r).every((k) => keys.includes(k));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function parseSetBody(v: unknown): SetBody | undefined {
  if (!isRecord(v) || !only(v, ['k', 'id', 'f', 'o'])) return undefined;
  if (!isKind(v['k']) || v['k'] === 'msg' || !isShortId(v['id']) || !isRecord(v['f']))
    return undefined;
  if (v['o'] !== undefined && (v['k'] !== 'task' || !isMemberId(v['o']))) return undefined;
  const names = Object.keys(v['f']);
  if (names.length === 0 || names.length > MAX_FIELDS || !names.every((n) => FIELD_NAME.test(n))) {
    return undefined;
  }
  return v as unknown as SetBody;
}

export function parseDelBody(v: unknown): DelBody | undefined {
  if (!isRecord(v) || !only(v, ['k', 'id', 'o'])) return undefined;
  if (!isKind(v['k']) || !isShortId(v['id'])) return undefined;
  if (v['o'] !== undefined && !isMemberId(v['o'])) return undefined;
  return v as unknown as DelBody;
}

export function parseMsgBody(v: unknown): MsgBody | undefined {
  if (!isRecord(v) || !only(v, ['id', 'th', 'tx', 'mn', 'll'])) return undefined;
  if (!isShortId(v['id']) || typeof v['th'] !== 'string' || typeof v['tx'] !== 'string') {
    return undefined;
  }
  if (!/^[a-z]{1,8}(:[A-Za-z0-9_-]{1,64})?$/.test(v['th']) || v['tx'].length > MAX_MESSAGE_CHARS) {
    return undefined;
  }
  const mn = v['mn'];
  if (
    mn !== undefined &&
    (!Array.isArray(mn) || mn.length > MAX_MENTIONS || !mn.every(isMemberId))
  ) {
    return undefined;
  }
  const ll = v['ll'];
  if (ll !== undefined) {
    if (v['th'] !== `pin:${v['id']}` || !Array.isArray(ll) || ll.length !== 2) return undefined;
    const [lng, lat] = ll as unknown[];
    if (!finite(lng) || !finite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) return undefined;
  }
  return v as unknown as MsgBody;
}

export function parsePosBody(v: unknown): PosBody | undefined {
  if (!isRecord(v) || !only(v, ['la', 'lo', 'ac', 'el', 'at'])) return undefined;
  const { la, lo, ac, el, at } = v;
  if (!finite(la) || !finite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) return undefined;
  if (!Number.isSafeInteger(at) || (ac !== undefined && (!finite(ac) || ac < 0))) return undefined;
  if (el !== undefined && !finite(el)) return undefined;
  return v as unknown as PosBody;
}

export interface EntityRecord {
  kind: EntityKind;
  id: string;
  owner?: string;
  state: EntityState;
  /** Audience/priority of the creating op (messages). */
  aud?: Audience;
  pr?: 1 | 2;
}

export interface TeamData {
  entities: Map<string, EntityRecord>;
  positions: Map<string, Register<PosBody & Record<string, Json>>>;
  /** Ops we could not decrypt (missing key, not a sealed recipient) or whose body was invalid. */
  skipped: { id: string; why: 'undecryptable' | 'invalid' | 'forbidden' }[];
}

/** Decrypts one op's body (the replica caches this). */
export type Decode = (op: SignedOp) => Json | undefined;

export function emptyData(): TeamData {
  return { entities: new Map(), positions: new Map(), skipped: [] };
}

/**
 * Reduce a resolved team's data ops, plus the ephemeral ops the caller
 * admitted (`admitEphemeral`), into the data view.
 */
export function reduceData(
  state: TeamState,
  decode: Decode,
  ephemeral: readonly SignedOp[] = [],
): TeamData {
  const out = emptyData();
  for (const op of state.data) applyDataOp(out, state, op, decode);
  for (const op of ephemeral) applyDataOp(out, state, op, decode);
  return out;
}

/**
 * Fold one accepted op into a data view (incremental: the replica calls this
 * for appended ops instead of rebuilding, review M2).
 */
export function applyDataOp(out: TeamData, state: TeamState, op: SignedOp, decode: Decode): void {
  const merge = (key: string, rec: Omit<EntityRecord, 'state'>, patch: EntityState) => {
    const prev = out.entities.get(key);
    out.entities.set(
      key,
      prev ? { ...prev, state: mergeEntity(prev.state, patch) } : { ...rec, state: patch },
    );
  };
  const { env, stamp } = op;
  // Authority is the author's role at the op's position in the fold (review M4).
  const role = state.roleAt.get(op.id);
  const forbid = () => {
    out.skipped.push({ id: op.id, why: 'forbidden' });
  };
  const body = decode(op);
  if (body === undefined) {
    out.skipped.push({ id: op.id, why: 'undecryptable' });
    return;
  }
  switch (env.t) {
    case 'e.set': {
      const b = parseSetBody(body);
      if (!b) break;
      // Fail closed: every accepted data op has a role; guests write comments only.
      if (role === undefined || (role === 'guest' && !GUEST_KINDS.includes(b.k))) return forbid();
      if (b.k === 'task') {
        if (!validTaskFields(b.f, env.au)) break;
        const owner = b.o ?? env.au;
        const key = entityKey('task', b.id, owner);
        if (owner !== env.au && !isAdminRole(role)) {
          // Not mine and I'm no admin: only the current assignee, only the status.
          const cur = out.entities.get(key);
          const assignee =
            cur && isLive(cur.state) ? visibleFields(cur.state)['assignee'] : undefined;
          if (assignee !== env.au || !isTaskStatusUpdate(b.f)) return forbid();
        }
        merge(key, { kind: 'task', id: b.id, owner }, setOp(b.f, stamp));
        return;
      }
      const owner = OWNED_KINDS.includes(b.k) ? env.au : undefined;
      const rec: Omit<EntityRecord, 'state'> = { kind: b.k, id: b.id };
      if (owner) rec.owner = owner;
      merge(entityKey(b.k, b.id, owner), rec, setOp(b.f, stamp));
      return;
    }
    case 'e.del': {
      const b = parseDelBody(body);
      if (!b) break;
      const owned = OWNED_KINDS.includes(b.k);
      const owner = owned ? (b.o ?? env.au) : undefined;
      if (role === undefined || (role === 'guest' && !GUEST_KINDS.includes(b.k))) return forbid();
      if (owned && owner !== env.au && !isAdminRole(role)) return forbid();
      const rec: Omit<EntityRecord, 'state'> = { kind: b.k, id: b.id };
      if (owner) rec.owner = owner;
      merge(entityKey(b.k, b.id, owner), rec, deleteOp(stamp));
      return;
    }
    case 'msg': {
      const b = parseMsgBody(body);
      if (!b) break;
      const key = entityKey('msg', b.id, env.au);
      if (out.entities.get(key)?.state.created !== undefined) return; // immutable: first wins
      const fields = dict<Json>([
        ['th', b.th],
        ['tx', b.tx],
      ]);
      if (b.mn) fields['mn'] = b.mn;
      if (b.ll) fields['ll'] = b.ll;
      const rec: Omit<EntityRecord, 'state'> = { kind: 'msg', id: b.id, owner: env.au };
      const aud = env.aud === undefined ? undefined : parseAudience(env.aud);
      if (aud) rec.aud = aud;
      if (env.pr !== undefined) rec.pr = env.pr;
      merge(key, rec, setOp(fields, stamp));
      return;
    }
    case 'pos': {
      const b = parsePosBody(body);
      if (!b) break;
      const reg = { value: b as PosBody & Record<string, Json>, stamp };
      const prev = out.positions.get(env.au);
      out.positions.set(env.au, prev ? mergeRegister(prev, reg) : reg);
      return;
    }
  }
  out.skipped.push({ id: op.id, why: 'invalid' });
}
