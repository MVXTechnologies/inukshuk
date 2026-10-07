import { isRecord, type Json } from './canonical';
import {
  deleteOp,
  mergeEntity,
  mergeRegister,
  setOp,
  type EntityState,
  type Register,
} from './crdt';
import type { SignedOp } from './envelope';
import { isMemberId, isShortId } from './ids';
import type { TeamState } from './membership';
import { isAdminRole, parseAudience, type Audience } from './roles';

/**
 * Team data, reduced from the valid data ops of a resolved team (#589).
 *
 * | kind | owned? | who writes | who deletes |
 * |---|---|---|---|
 * | `wpt`, `point`, `task` | shared | any member | any member |
 * | `track`, `photo`, `comment` | owned | the creator only | creator or an admin |
 * | `msg` (from `msg` ops) | owned, immutable | the creator, once | creator or admin (redact) |
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
export const OWNED_KINDS: readonly EntityKind[] = ['track', 'photo', 'comment', 'msg'];

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
  if (!isRecord(v) || !only(v, ['k', 'id', 'f'])) return undefined;
  if (!isKind(v['k']) || v['k'] === 'msg' || !isShortId(v['id']) || !isRecord(v['f']))
    return undefined;
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
  if (!isRecord(v) || !only(v, ['id', 'th', 'tx', 'mn'])) return undefined;
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

export function reduceData(state: TeamState, decode: Decode): TeamData {
  const out: TeamData = { entities: new Map(), positions: new Map(), skipped: [] };
  const merge = (key: string, rec: Omit<EntityRecord, 'state'>, patch: EntityState) => {
    const prev = out.entities.get(key);
    out.entities.set(
      key,
      prev ? { ...prev, state: mergeEntity(prev.state, patch) } : { ...rec, state: patch },
    );
  };
  for (const op of state.data) {
    const { env, stamp } = op;
    const body = decode(op);
    if (body === undefined) {
      out.skipped.push({ id: op.id, why: 'undecryptable' });
      continue;
    }
    const author = state.members.get(env.au);
    switch (env.t) {
      case 'e.set': {
        const b = parseSetBody(body);
        if (!b) break;
        const owner = OWNED_KINDS.includes(b.k) ? env.au : undefined;
        const rec: Omit<EntityRecord, 'state'> = { kind: b.k, id: b.id };
        if (owner) rec.owner = owner;
        merge(entityKey(b.k, b.id, owner), rec, setOp(b.f, stamp));
        continue;
      }
      case 'e.del': {
        const b = parseDelBody(body);
        if (!b) break;
        const owned = OWNED_KINDS.includes(b.k);
        const owner = owned ? (b.o ?? env.au) : undefined;
        if (owned && owner !== env.au && !(author && isAdminRole(author.role))) {
          out.skipped.push({ id: op.id, why: 'forbidden' });
          continue;
        }
        const rec: Omit<EntityRecord, 'state'> = { kind: b.k, id: b.id };
        if (owner) rec.owner = owner;
        merge(entityKey(b.k, b.id, owner), rec, deleteOp(stamp));
        continue;
      }
      case 'msg': {
        const b = parseMsgBody(body);
        if (!b) break;
        const key = entityKey('msg', b.id, env.au);
        if (out.entities.get(key)?.state.created !== undefined) continue; // immutable: first wins
        const fields: Record<string, Json> = { th: b.th, tx: b.tx };
        if (b.mn) fields['mn'] = b.mn;
        const rec: Omit<EntityRecord, 'state'> = { kind: 'msg', id: b.id, owner: env.au };
        const aud = env.aud === undefined ? undefined : parseAudience(env.aud);
        if (aud) rec.aud = aud;
        if (env.pr !== undefined) rec.pr = env.pr;
        merge(key, rec, setOp(fields, stamp));
        continue;
      }
      case 'pos': {
        const b = parsePosBody(body);
        if (!b) break;
        const reg = { value: b as PosBody & Record<string, Json>, stamp };
        const prev = out.positions.get(env.au);
        out.positions.set(env.au, prev ? mergeRegister(prev, reg) : reg);
        continue;
      }
    }
    out.skipped.push({ id: op.id, why: 'invalid' });
  }
  return out;
}
