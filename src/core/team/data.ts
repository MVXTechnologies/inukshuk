import { isRecord, type Json } from './canonical';
import {
  deleteOp,
  dict,
  mergeEntity,
  mergeRegister,
  setOp,
  type EntityState,
  type Register,
} from './crdt';
import type { SignedOp } from './envelope';
import { isMemberId, isShortId } from './ids';
import type { TeamState } from './membership';
import { parseAudience, type Audience } from './roles';
import { emptyIndex, RECORD_KINDS, type RecordIndex } from './records';
import { KIND_NAME, recordKey, type DomainLookup, type KindWrite } from '@core/group/registry';

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
 * | `drw` map drawing (#683) | owned | the creator (members); later only its note | creator or admin |
 * | `cap` capabilities (#683) | owned, id = the member | the member (guests too) | member or admin |
 * | `rcp` receipts (#708) | owned, id = the alert's | the receiver (guests too) | receiver or admin |
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
 *
 * **Sync groups (2.7.0).** The fold below is group-generic: record writes are
 * dispatched by kind to domain plug-ins (`@core/group/registry`). The team
 * rules in this table live in the team plug-in (`@core/domains/team`), which
 * wraps this module's parsers and `records.ts` / `tasks.ts` unchanged.
 */
export const ENTITY_KINDS = [
  'wpt',
  'point',
  'task',
  'track',
  'photo',
  'comment',
  'msg',
  ...RECORD_KINDS,
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];
export const OWNED_KINDS: readonly EntityKind[] = [
  'tve',
  'task',
  'track',
  'photo',
  'comment',
  'msg',
  'trl',
  'sos',
  'rly',
  'mres',
  'drw',
  'cap',
  'rcp',
];
/** Entity kinds a guest may write (their own records only). */
export const GUEST_KINDS: readonly EntityKind[] = ['comment', 'sos', 'mres', 'cap', 'rcp'];
/** Kinds whose `e.set` may name another member's record (`o`). */
export const OWNER_REF_KINDS: readonly string[] = ['task', 'trl', 'sos', 'mres', 'tve'];

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

/** A record write as the group fold sees it, before any domain looked at its kind. */
export interface KindWriteBody {
  k: string;
  id: string;
  /** `e.set` only. */
  f?: Record<string, Json>;
  o?: string;
}

/**
 * The domain-independent shape of an `e.set` / `e.del` body: known keys
 * only, a well-formed kind name, a short id, a member id in `o`, and for a
 * set 1–{@link MAX_FIELDS} well-named fields. Which kinds exist, and which
 * take `o`, is the owning domain's call.
 */
export function parseKindWrite(t: 'e.set' | 'e.del', v: unknown): KindWriteBody | undefined {
  if (!isRecord(v) || !only(v, t === 'e.set' ? ['k', 'id', 'f', 'o'] : ['k', 'id', 'o']))
    return undefined;
  if (typeof v['k'] !== 'string' || !KIND_NAME.test(v['k']) || !isShortId(v['id']))
    return undefined;
  if (v['o'] !== undefined && !isMemberId(v['o'])) return undefined;
  if (t === 'e.del') return v as unknown as KindWriteBody;
  const f = v['f'];
  if (!isRecord(f)) return undefined;
  const names = Object.keys(f);
  if (names.length === 0 || names.length > MAX_FIELDS || !names.every((n) => FIELD_NAME.test(n))) {
    return undefined;
  }
  return v as unknown as KindWriteBody;
}

export function parseSetBody(v: unknown): SetBody | undefined {
  if (!isRecord(v) || !only(v, ['k', 'id', 'f', 'o'])) return undefined;
  if (!isKind(v['k']) || v['k'] === 'msg' || !isShortId(v['id']) || !isRecord(v['f']))
    return undefined;
  if (v['o'] !== undefined && (!OWNER_REF_KINDS.includes(v['k']) || !isMemberId(v['o'])))
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

const THREAD = /^[a-z]{1,8}(:[A-Za-z0-9_-]{1,64})?$/;
/** `pin:<owner member id>:<pin id>`: a pin's thread names its owner, so nobody else can root it. */
const PIN_THREAD = /^pin:([A-Za-z0-9_-]{43}):([A-Za-z0-9_-]{1,64})$/;

export function parseMsgBody(v: unknown): MsgBody | undefined {
  if (!isRecord(v) || !only(v, ['id', 'th', 'tx', 'mn', 'll'])) return undefined;
  if (!isShortId(v['id']) || typeof v['th'] !== 'string' || typeof v['tx'] !== 'string') {
    return undefined;
  }
  const th = v['th'];
  const pin = PIN_THREAD.exec(th);
  if (th.startsWith('pin:') ? !pin || !isMemberId(pin[1]) : !THREAD.test(th)) return undefined;
  if (v['tx'].length > MAX_MESSAGE_CHARS) return undefined;
  const mn = v['mn'];
  if (
    mn !== undefined &&
    (!Array.isArray(mn) || mn.length > MAX_MENTIONS || !mn.every(isMemberId))
  ) {
    return undefined;
  }
  const ll = v['ll'];
  if (ll !== undefined) {
    // A pin's root: on its own thread `pin:<author>:<its id>` (the author is checked by the fold).
    if (!pin || pin[2] !== v['id'] || !Array.isArray(ll) || ll.length !== 2) return undefined;
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
  /** A team kind ({@link EntityKind}) or another domain's (2.7.0 sync groups). */
  kind: string;
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
  /**
   * Ops not folded: undecryptable (missing key, not a sealed recipient),
   * invalid, forbidden at their fold position, or of a kind no domain here
   * registers (`unknown`: a newer app's record, stored and relayed).
   */
  skipped: { id: string; why: SkipReason }[];
  /** Counters for constant-time record authorization (`records.ts`). */
  index: RecordIndex;
}

export type SkipReason = 'undecryptable' | 'invalid' | 'forbidden' | 'unknown';

/** Decrypts one op's body (the replica caches this). */
export type Decode = (op: SignedOp) => Json | undefined;

export function emptyData(): TeamData {
  return { entities: new Map(), positions: new Map(), skipped: [], index: emptyIndex() };
}

/**
 * Reduce a resolved group's data ops, plus the ephemeral ops the caller
 * admitted (`admitEphemeral`), into the data view, dispatching each record
 * write to the domain plug-in that owns its kind (`registry`).
 */
export function reduceData(
  state: TeamState,
  decode: Decode,
  registry: DomainLookup,
  ephemeral: readonly SignedOp[] = [],
): TeamData {
  const out = emptyData();
  for (const op of state.data) applyDataOp(out, state, op, decode, registry);
  for (const op of ephemeral) applyDataOp(out, state, op, decode, registry);
  return out;
}

const NO_FIELDS: Readonly<Record<string, Json>> = Object.freeze({});

/**
 * Fold one accepted op into a data view (incremental: the replica calls this
 * for appended ops instead of rebuilding, review M2).
 *
 * Record writes (`e.set` / `e.del`) go through the sync-group seam (2.7.0,
 * `docs/design/sync-layer.md` §5.1): the generic shape check, then the
 * plug-in owning the kind (none: skipped as `unknown`, a newer app's kind,
 * still stored and relayed), its `validate`, the fail-closed role check, its
 * `authorize` at the op's fold position, then the per-field LWW merge.
 * Messages and positions are group-generic and folded here.
 */
export function applyDataOp(
  out: TeamData,
  state: TeamState,
  op: SignedOp,
  decode: Decode,
  registry: DomainLookup,
): void {
  const { env, stamp } = op;
  // Authority is the author's role at the op's position in the fold (review M4).
  const role = state.roleAt.get(op.id);
  const skip = (why: SkipReason) => {
    out.skipped.push({ id: op.id, why });
  };
  const body = decode(op);
  if (body === undefined) return skip('undecryptable');
  switch (env.t) {
    case 'e.set':
    case 'e.del': {
      const b = parseKindWrite(env.t, body);
      if (!b) break;
      const plugin = registry.forKind(b.k);
      if (plugin === undefined) return skip('unknown');
      const w: KindWrite = {
        op: env.t === 'e.set' ? 'set' : 'del',
        kind: b.k,
        id: b.id,
        f: b.f ?? NO_FIELDS,
        o: b.o,
        author: env.au,
        wall: stamp.wall,
      };
      if (!plugin.validate(w)) break;
      // Fail closed: every accepted data op has a role.
      if (role === undefined) return skip('forbidden');
      const r = plugin.authorize(w, role, out, state);
      if (r === 'invalid') break;
      if (r === 'forbidden') return skip('forbidden');
      const key = recordKey(plugin.owned(b.k), b.k, b.id, r.owner);
      const rec: Omit<EntityRecord, 'state'> = { kind: b.k, id: b.id };
      if (r.owner !== undefined) rec.owner = r.owner;
      const patch = w.op === 'set' ? setOp(b.f ?? NO_FIELDS, stamp) : deleteOp(stamp);
      const prev = out.entities.get(key);
      const next = prev
        ? { ...prev, state: mergeEntity(prev.state, patch) }
        : { ...rec, state: patch };
      out.entities.set(key, next);
      plugin.merged?.(out, next, prev?.state);
      return;
    }
    case 'msg': {
      const b = parseMsgBody(body);
      if (!b) break;
      // Only the owner named in a pin thread can root it (review: pin hijack).
      if (b.ll && b.th !== `pin:${env.au}:${b.id}`) break;
      const key = entityKey('msg', b.id, env.au);
      const prev = out.entities.get(key);
      if (prev?.state.created !== undefined) return; // immutable: first wins
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
      const patch = setOp(fields, stamp);
      out.entities.set(
        key,
        prev ? { ...prev, state: mergeEntity(prev.state, patch) } : { ...rec, state: patch },
      );
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
  skip('invalid');
}
