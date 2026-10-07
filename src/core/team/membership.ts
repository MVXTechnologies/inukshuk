import { fromB64uLen, isB64uLen } from './bytes';
import { hasOnlyKeys, isRecord } from './canonical';
import { KEY_BYTES, type TeamCrypto } from './crypto';
import { isControlType, type SignedOp } from './envelope';
import { compareStamp, type Stamp } from './hlc';
import { deriveTeamId, isMemberId, isShortId, memberPublicKey } from './ids';
import { parseJoinProof, verifyJoinProof } from './invite';
import { parseKeyWraps, wrapCoverage, type KeyWraps } from './keys';
import {
  canGrantRole,
  canManage,
  canSetParent,
  canUsePriority,
  canWriteData,
  isAdminRole,
  isRole,
  MAX_GROUPS,
  parseAudience,
  parseGroupLinks,
  type GroupLink,
  type Role,
} from './roles';

/**
 * The team's membership log, resolved (#589, deliverable 2).
 *
 * The log is a set of signed ops; every peer folds it in the same total order
 * — `(hlc.wall, hlc.counter, author, opId)` — and checks each op against the
 * state *at that point*. So the result depends only on the set of ops, never
 * on arrival order: two peers with the same ops agree on every member, role,
 * key and rejection.
 *
 * **Authority chain.** The genesis author is the owner (exactly one, never
 * removable). The owner grants and revokes admin. Admins add, update and
 * remove members and guests, create invites, define groups, extend or close
 * the team and rotate keys. Any member (not guest) may *admit* a joiner who
 * proves an admin-created invite, which is how "admins sign membership" still
 * works when no admin is in Wi-Fi range: the admin signed the invite.
 *
 * **Concurrent admin actions** resolve by the total order: the later op wins
 * (LWW per member), and an op whose target is gone by then is rejected (so a
 * removal beats a concurrent role change regardless of HLC order, because a
 * role change on a removed member is invalid and a removal after a role
 * change still removes).
 *
 * **Backdating.** HLCs are author-chosen, so a removed or demoted member could
 * sign ops with old timestamps. Removals and admin demotions therefore carry a
 * `cut`: the target's last sequence number the remover had seen. The target's
 * ops with `sq > cut` are rejected (removal) or lose admin authority (demotion)
 * wherever their HLC sorts. Work the target did that the remover had not yet
 * received is dropped — the price of determinism without a server.
 *
 * Removal cuts are applied in a second pass, because a backdated op sorts
 * before the removal that disqualifies it. Admin cuts can only come from the
 * owner (always authoritative), so they are collected up front.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_TEAM_LIFETIME_MS = 14 * DAY_MS;
export const MAX_TEAM_LIFETIME_MS = 365 * DAY_MS;
export const MAX_INVITE_TTL_MS = 30 * DAY_MS;
export const MAX_INVITE_USES = 1000;
export const MAX_MEMBERS = 500;

export interface MemberState {
  id: string;
  /** X25519 public key (base64url). */
  x: string;
  role: Role;
  groups: GroupLink[];
  status: 'active' | 'removed';
  via: 'genesis' | 'add' | 'admit';
  joinedAt: Stamp;
  joinedBy: string;
  /** The op that introduced the member (its `c` holds their display name). */
  joinOp: string;
  inviteId?: string;
  removedAt?: Stamp;
  removeCut?: number;
  /** Admin ops need `sq > adminFrom` (ops signed before the grant don't count). */
  adminFrom?: number;
  /** Set once an admin is demoted; re-promotion is refused in v1. */
  adminCut?: number;
}

export interface InviteState {
  id: string;
  by: string;
  createdAt: Stamp;
  opId: string;
  expiresAt: number;
  maxUses: number;
  uses: number;
  role: Role;
  groups: GroupLink[];
  approve: 'any' | 'admin';
  revoked: boolean;
}

export interface KeyState {
  keyId: string;
  createdBy: string;
  createdAt: Stamp;
  opId: string;
  /** Members a wrap of this key was published for. */
  recipients: Set<string>;
}

export type Rejection =
  | 'no-genesis'
  | 'duplicate-genesis'
  | 'before-genesis'
  | 'removed'
  | 'not-member'
  | 'forbidden'
  | 'invalid-body'
  | 'unknown-target'
  | 'exists'
  | 'expired'
  | 'closed'
  | 'invite'
  | 'limit'
  | 'key';

export interface TeamState {
  teamId: string;
  owner?: string;
  genesis?: SignedOp;
  members: Map<string, MemberState>;
  /** Group id → parent id. */
  groups: Map<string, string | undefined>;
  invites: Map<string, InviteState>;
  expiresAt: number;
  closedAt?: Stamp;
  keys: Map<string, KeyState>;
  /** Key ids in creation order (fold order). */
  keyOrder: string[];
  /** The key to encrypt new group-mode ops with; `undefined` = must wait for a rotation. */
  sendKeyId?: string;
  /** True when the newest key reached someone since removed (or none exists). */
  needsRotation: boolean;
  /** Active members with no wrap of the send key (someone should `k.share`). */
  missingKey: string[];
  /** Valid control ops, in fold order. */
  control: SignedOp[];
  /** Valid data and ephemeral ops, in fold order. */
  data: SignedOp[];
  rejected: Map<string, Rejection>;
}

/** The total order every peer folds in. */
export function compareOps(a: SignedOp, b: SignedOp): number {
  return compareStamp(a.stamp, b.stamp) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// ── Body parsing (strict: unknown keys or bad types → invalid) ──────────────

type Body = Record<string, unknown>;

const isInt = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && (v as number) >= min;
const isBox = (v: unknown): v is string => isB64uLen(v, KEY_BYTES);

function body(op: SignedOp, keys: readonly string[]): Body | undefined {
  const b = op.env.b;
  return isRecord(b) && hasOnlyKeys(b, keys) ? b : undefined;
}

interface Ctx {
  c: TeamCrypto;
  teamId: string;
  removeCuts: ReadonlyMap<string, number>;
  adminCuts: ReadonlyMap<string, number>;
  /** Join-proof verdicts by op id (two Ed25519 verifies each; cached across recomputes). */
  proofCache: Map<string, boolean>;
}

export interface ResolveOptions {
  /** Pass the same map on every recompute to verify each join proof once. */
  proofCache?: Map<string, boolean>;
}

function emptyState(teamId: string): TeamState {
  return {
    teamId,
    members: new Map(),
    groups: new Map(),
    invites: new Map(),
    expiresAt: 0,
    keys: new Map(),
    keyOrder: [],
    needsRotation: true,
    missingKey: [],
    control: [],
    data: [],
    rejected: new Map(),
  };
}

function pickGenesis(c: TeamCrypto, teamId: string, ops: readonly SignedOp[]) {
  const candidates = ops
    .filter((op) => {
      if (op.env.t !== 'm.genesis' || op.env.sq !== 1) return false;
      const b = body(op, ['nonce', 'x', 'exp', 'kw']);
      if (b === undefined || !isBox(b['x']) || !isInt(b['exp'])) return false;
      const nonce = fromB64uLen(b['nonce'], 16);
      const pub = memberPublicKey(op.env.au);
      if (nonce === undefined || pub === undefined) return false;
      if (deriveTeamId(c, pub, nonce) !== teamId) return false;
      const exp = b['exp'];
      if (exp <= op.stamp.wall || exp > op.stamp.wall + MAX_TEAM_LIFETIME_MS) return false;
      const kw = parseKeyWraps(b['kw']);
      if (kw === undefined) return false;
      const cov = wrapCoverage(kw);
      return cov.keyIds.size === 1 && cov.members.size === 1 && cov.members.has(op.env.au);
    })
    .sort(compareOps);
  return candidates[0];
}

/** Admin cuts can only be signed by the owner, who is always authoritative. */
function collectAdminCuts(owner: string, ops: readonly SignedOp[]): Map<string, number> {
  const cuts = new Map<string, number>();
  for (const op of ops) {
    if (op.env.au !== owner || (op.env.t !== 'm.update' && op.env.t !== 'm.remove')) continue;
    const b = op.env.b;
    if (!isRecord(b) || !isMemberId(b['m']) || !isInt(b['cut'])) continue;
    if (op.env.t === 'm.update' && (b['r'] === undefined || b['r'] === 'admin')) continue;
    const prev = cuts.get(b['m']);
    cuts.set(b['m'], prev === undefined ? b['cut'] : Math.min(prev, b['cut']));
  }
  return cuts;
}

function fold(
  ctx: Ctx,
  genesis: SignedOp,
  sorted: readonly SignedOp[],
): { state: TeamState; removeCuts: Map<string, number> } {
  const s = emptyState(ctx.teamId);
  const removeCuts = new Map<string, number>();
  const gb = genesis.env.b as Body;
  const owner = genesis.env.au;
  s.owner = owner;
  s.genesis = genesis;
  s.expiresAt = gb['exp'] as number;
  s.members.set(owner, {
    id: owner,
    x: gb['x'] as string,
    role: 'owner',
    groups: [],
    status: 'active',
    via: 'genesis',
    joinedAt: genesis.stamp,
    joinedBy: owner,
    joinOp: genesis.id,
  });
  const k0 = parseKeyWraps(gb['kw'])!.w[0]![1];
  s.keys.set(k0, {
    keyId: k0,
    createdBy: owner,
    createdAt: genesis.stamp,
    opId: genesis.id,
    recipients: new Set([owner]),
  });
  s.keyOrder.push(k0);
  s.control.push(genesis);

  const reject = (op: SignedOp, why: Rejection) => s.rejected.set(op.id, why);
  let active = 1;
  const activeCount = () => active;
  const adminOk = (m: MemberState, sq: number) => {
    if (!isAdminRole(m.role) || sq <= (m.adminFrom ?? 0)) return false;
    const cut = ctx.adminCuts.get(m.id);
    return m.role === 'owner' || cut === undefined || sq <= cut;
  };
  const groupsExist = (links: readonly GroupLink[]) => links.every((l) => s.groups.has(l.g));
  /** Validate wraps: every recipient active (or `extra`), every key known (or `newKey`). */
  const wrapsOk = (kw: KeyWraps, extra?: string, newKey = false) => {
    const cov = wrapCoverage(kw);
    for (const m of cov.members) {
      if (m !== extra && s.members.get(m)?.status !== 'active') return false;
    }
    if (newKey) return cov.keyIds.size === 1 && !s.keys.has([...cov.keyIds][0]!);
    return [...cov.keyIds].every((k) => s.keys.has(k));
  };
  const addRecipients = (kw: KeyWraps) => {
    for (const [m, k] of kw.w) s.keys.get(k)?.recipients.add(m);
  };

  for (const op of sorted) {
    if (op === genesis) continue;
    const { env } = op;
    if (env.t === 'm.genesis') {
      reject(op, 'duplicate-genesis');
      continue;
    }
    if (compareOps(op, genesis) < 0) {
      reject(op, 'before-genesis');
      continue;
    }
    const cut = ctx.removeCuts.get(env.au);
    if (cut !== undefined && env.sq > cut) {
      reject(op, 'removed');
      continue;
    }
    const author = s.members.get(env.au);
    if (author === undefined || author.status !== 'active') {
      reject(op, author === undefined ? 'not-member' : 'removed');
      continue;
    }
    if (s.closedAt !== undefined) {
      reject(op, 'closed');
      continue;
    }
    if (env.t !== 't.extend' && op.stamp.wall > s.expiresAt) {
      reject(op, 'expired');
      continue;
    }

    if (!isControlType(env.t)) {
      // Data / ephemeral op.
      if (!canWriteData(author.role, env.t)) {
        reject(op, 'forbidden');
        continue;
      }
      if (env.k !== undefined && !s.keys.get(env.k)?.recipients.has(env.au)) {
        reject(op, 'key');
        continue;
      }
      if (env.x !== undefined && env.x.w.some(([m]) => s.members.get(m)?.status !== 'active')) {
        reject(op, 'unknown-target');
        continue;
      }
      const aud = env.aud === undefined ? undefined : parseAudience(env.aud);
      if (env.pr !== undefined && !canUsePriority(author, env.pr, aud, s.groups)) {
        reject(op, 'forbidden');
        continue;
      }
      s.data.push(op);
      continue;
    }

    const why = applyControl(ctx, s, op, author, {
      adminOk,
      groupsExist,
      wrapsOk,
      addRecipients,
      activeCount,
      removeCuts,
    });
    if (why === undefined) {
      s.control.push(op);
      if (env.t === 'm.add' || env.t === 'm.admit') active++;
      else if (env.t === 'm.remove') active--;
    } else reject(op, why);
  }

  // Key safety: the newest key is usable only if nobody it reached was removed.
  const newest = s.keyOrder[s.keyOrder.length - 1];
  const newestKey = newest === undefined ? undefined : s.keys.get(newest);
  const leaked =
    newestKey === undefined ||
    [...newestKey.recipients].some((m) => s.members.get(m)?.status !== 'active');
  s.needsRotation = leaked;
  s.sendKeyId = leaked ? undefined : newest;
  s.missingKey =
    newestKey === undefined
      ? []
      : [...s.members.values()]
          .filter((m) => m.status === 'active' && !newestKey.recipients.has(m.id))
          .map((m) => m.id)
          .sort();
  return { state: s, removeCuts };
}

interface Helpers {
  adminOk: (m: MemberState, sq: number) => boolean;
  groupsExist: (links: readonly GroupLink[]) => boolean;
  wrapsOk: (kw: KeyWraps, extra?: string, newKey?: boolean) => boolean;
  addRecipients: (kw: KeyWraps) => void;
  activeCount: () => number;
  removeCuts: Map<string, number>;
}

function applyControl(
  ctx: Ctx,
  s: TeamState,
  op: SignedOp,
  author: MemberState,
  h: Helpers,
): Rejection | undefined {
  const { env, stamp } = op;
  const admin = h.adminOk(author, env.sq);
  switch (env.t) {
    case 'm.add': {
      const b = body(op, ['m', 'x', 'r', 'g', 'from', 'kw']);
      const groups = parseGroupLinks(b?.['g']);
      const kw = parseKeyWraps(b?.['kw']);
      if (!b || !isMemberId(b['m']) || !isBox(b['x']) || !isRole(b['r']) || !groups || !kw) {
        return 'invalid-body';
      }
      if (b['from'] !== undefined && !isInt(b['from'])) return 'invalid-body';
      if (!admin || !canGrantRole(author.role, b['r'])) return 'forbidden';
      if (s.members.has(b['m'])) return 'exists';
      if (!h.groupsExist(groups)) return 'unknown-target';
      if (h.activeCount() >= MAX_MEMBERS) return 'limit';
      if (!h.wrapsOk(kw, b['m']) || !wrapCoverage(kw).members.has(b['m'])) return 'key';
      const m: MemberState = {
        id: b['m'],
        x: b['x'],
        role: b['r'],
        groups,
        status: 'active',
        via: 'add',
        joinedAt: stamp,
        joinedBy: env.au,
        joinOp: op.id,
      };
      if (b['r'] === 'admin') m.adminFrom = (b['from'] as number | undefined) ?? 0;
      s.members.set(m.id, m);
      h.addRecipients(kw);
      return undefined;
    }
    case 'm.admit': {
      const b = body(op, ['m', 'x', 'inv', 'ip', 'js', 'kw']);
      const proof = parseJoinProof(b);
      const kw = parseKeyWraps(b?.['kw']);
      if (!b || !proof || !kw) return 'invalid-body';
      if (author.role === 'guest') return 'forbidden';
      const inv = s.invites.get(proof.inv);
      if (inv === undefined || inv.revoked) return 'invite';
      if (stamp.wall > inv.expiresAt || inv.uses >= inv.maxUses) return 'invite';
      if (inv.approve === 'admin' && !admin) return 'forbidden';
      let proofOk = ctx.proofCache.get(op.id);
      if (proofOk === undefined) {
        proofOk = verifyJoinProof(ctx.c, ctx.teamId, proof);
        ctx.proofCache.set(op.id, proofOk);
      }
      if (!proofOk) return 'invite';
      if (s.members.has(proof.m)) return 'exists';
      if (h.activeCount() >= MAX_MEMBERS) return 'limit';
      if (!h.wrapsOk(kw, proof.m) || !wrapCoverage(kw).members.has(proof.m)) return 'key';
      inv.uses++;
      s.members.set(proof.m, {
        id: proof.m,
        x: proof.x,
        role: inv.role,
        groups: inv.groups.filter((l) => s.groups.has(l.g)),
        status: 'active',
        via: 'admit',
        joinedAt: stamp,
        joinedBy: env.au,
        joinOp: op.id,
        inviteId: inv.id,
      });
      h.addRecipients(kw);
      return undefined;
    }
    case 'm.update': {
      const b = body(op, ['m', 'r', 'g', 'cut', 'from']);
      if (!b || !isMemberId(b['m'])) return 'invalid-body';
      const role = b['r'];
      const groups = b['g'] === undefined ? undefined : parseGroupLinks(b['g']);
      if ((role !== undefined && !isRole(role)) || (b['g'] !== undefined && !groups)) {
        return 'invalid-body';
      }
      if (role === undefined && groups === undefined) return 'invalid-body';
      if (b['cut'] !== undefined && !isInt(b['cut'])) return 'invalid-body';
      if (b['from'] !== undefined && !isInt(b['from'])) return 'invalid-body';
      const target = s.members.get(b['m']);
      if (target === undefined || target.status !== 'active') return 'unknown-target';
      if (!admin || !canManage(author.role, target.role)) return 'forbidden';
      if (role !== undefined && !canGrantRole(author.role, role)) return 'forbidden';
      if (groups && !h.groupsExist(groups)) return 'unknown-target';
      if (role !== undefined && role !== target.role) {
        const demotingAdmin = target.role === 'admin' && role !== 'admin';
        if (demotingAdmin && !isInt(b['cut'])) return 'invalid-body';
        if (role === 'admin' && target.adminCut !== undefined) return 'forbidden';
        if (demotingAdmin) target.adminCut = b['cut'] as number;
        if (role === 'admin') target.adminFrom = (b['from'] as number | undefined) ?? 0;
        target.role = role;
      }
      if (groups) target.groups = groups;
      return undefined;
    }
    case 'm.remove': {
      const b = body(op, ['m', 'cut']);
      if (!b || !isMemberId(b['m']) || !isInt(b['cut'])) return 'invalid-body';
      const target = s.members.get(b['m']);
      if (target === undefined || target.status !== 'active') return 'unknown-target';
      if (!admin || !canManage(author.role, target.role)) return 'forbidden';
      target.status = 'removed';
      target.removedAt = stamp;
      target.removeCut = b['cut'];
      if (target.role === 'admin') target.adminCut = b['cut'];
      h.removeCuts.set(target.id, b['cut']);
      return undefined;
    }
    case 'i.create': {
      const b = body(op, ['inv', 'exp', 'max', 'r', 'g', 'ap']);
      const groups = parseGroupLinks(b?.['g']);
      if (!b || !isMemberId(b['inv']) || !isInt(b['exp']) || !isInt(b['max'], 1) || !groups) {
        return 'invalid-body';
      }
      if (!isRole(b['r']) || (b['ap'] !== 'any' && b['ap'] !== 'admin')) return 'invalid-body';
      if (b['max'] > MAX_INVITE_USES) return 'invalid-body';
      if (b['exp'] <= stamp.wall || b['exp'] > stamp.wall + MAX_INVITE_TTL_MS)
        return 'invalid-body';
      // Invites only mint members and guests: admins are granted by the owner, by hand.
      if (!admin || (b['r'] !== 'member' && b['r'] !== 'guest')) return 'forbidden';
      if (!canGrantRole(author.role, b['r'])) return 'forbidden';
      if (s.invites.has(b['inv'])) return 'exists';
      if (!h.groupsExist(groups)) return 'unknown-target';
      s.invites.set(b['inv'], {
        id: b['inv'],
        by: env.au,
        createdAt: stamp,
        opId: op.id,
        expiresAt: b['exp'],
        maxUses: b['max'],
        uses: 0,
        role: b['r'],
        groups,
        approve: b['ap'],
        revoked: false,
      });
      return undefined;
    }
    case 'i.revoke': {
      const b = body(op, ['inv']);
      if (!b || !isMemberId(b['inv'])) return 'invalid-body';
      if (!admin) return 'forbidden';
      const inv = s.invites.get(b['inv']);
      if (inv === undefined) return 'unknown-target';
      inv.revoked = true;
      return undefined;
    }
    case 'g.set': {
      const b = body(op, ['id', 'p']);
      if (!b || !isShortId(b['id']) || (b['p'] !== undefined && !isShortId(b['p']))) {
        return 'invalid-body';
      }
      if (!admin) return 'forbidden';
      const parent = b['p'] as string | undefined;
      if (!s.groups.has(b['id']) && s.groups.size >= MAX_GROUPS) return 'limit';
      const tree = new Map(s.groups);
      if (!tree.has(b['id'])) tree.set(b['id'], undefined);
      if (!canSetParent(tree, b['id'], parent)) return 'invalid-body';
      s.groups.set(b['id'], parent);
      return undefined;
    }
    case 'g.del': {
      const b = body(op, ['id']);
      if (!b || !isShortId(b['id'])) return 'invalid-body';
      if (!admin) return 'forbidden';
      if (!s.groups.has(b['id'])) return 'unknown-target';
      if ([...s.groups.values()].includes(b['id'])) return 'forbidden'; // has children
      s.groups.delete(b['id']);
      return undefined;
    }
    case 't.extend': {
      const b = body(op, ['exp']);
      if (!b || !isInt(b['exp'])) return 'invalid-body';
      if (!admin) return 'forbidden';
      if (b['exp'] > s.genesis!.stamp.wall + MAX_TEAM_LIFETIME_MS) return 'limit';
      s.expiresAt = Math.max(s.expiresAt, b['exp']);
      return undefined;
    }
    case 't.close': {
      if (!body(op, [])) return 'invalid-body';
      if (!admin) return 'forbidden';
      s.closedAt = stamp;
      return undefined;
    }
    case 'k.rotate': {
      const b = body(op, ['kw']);
      const kw = parseKeyWraps(b?.['kw']);
      if (!b || !kw) return 'invalid-body';
      if (!admin) return 'forbidden';
      if (!h.wrapsOk(kw, undefined, true)) return 'key';
      const keyId = kw.w[0]![1];
      s.keys.set(keyId, {
        keyId,
        createdBy: env.au,
        createdAt: stamp,
        opId: op.id,
        recipients: new Set(),
      });
      s.keyOrder.push(keyId);
      h.addRecipients(kw);
      return undefined;
    }
    case 'k.share': {
      const b = body(op, ['kw']);
      const kw = parseKeyWraps(b?.['kw']);
      if (!b || !kw) return 'invalid-body';
      if (!h.wrapsOk(kw)) return 'key';
      // You can only share what you were given.
      if (![...wrapCoverage(kw).keyIds].every((k) => s.keys.get(k)!.recipients.has(env.au))) {
        return 'forbidden';
      }
      h.addRecipients(kw);
      return undefined;
    }
    default:
      return 'invalid-body';
  }
}

/**
 * Resolve the team from every op we hold (any order, duplicates allowed).
 * Pure and deterministic. Ops must already have passed `checkEnvelope` for
 * this team.
 */
export function resolveTeam(
  c: TeamCrypto,
  teamId: string,
  ops: readonly SignedOp[],
  options: ResolveOptions = {},
): TeamState {
  const unique = [...new Map(ops.map((op) => [op.id, op])).values()].sort(compareOps);
  const genesis = pickGenesis(c, teamId, unique);
  if (genesis === undefined) {
    const s = emptyState(teamId);
    for (const op of unique) s.rejected.set(op.id, 'no-genesis');
    return s;
  }
  const adminCuts = collectAdminCuts(genesis.env.au, unique);
  const base = {
    c,
    teamId,
    adminCuts,
    proofCache: options.proofCache ?? new Map<string, boolean>(),
  };
  // Pass A finds the valid removals; pass B enforces their cuts on ops that sort earlier.
  const passA = fold({ ...base, removeCuts: new Map() }, genesis, unique);
  if (passA.removeCuts.size === 0) return passA.state; // nothing to enforce retroactively
  return fold({ ...base, removeCuts: passA.removeCuts }, genesis, unique).state;
}

/** Active members, sorted by id. */
export function activeMembers(s: TeamState): MemberState[] {
  return [...s.members.values()]
    .filter((m) => m.status === 'active')
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function isActive(s: TeamState, memberId: string): boolean {
  return s.members.get(memberId)?.status === 'active';
}

/** The read-only state the UI shows once a team is past its expiry or closed. */
export function isReadOnly(s: TeamState, now: number): boolean {
  return s.closedAt !== undefined || now > s.expiresAt;
}
