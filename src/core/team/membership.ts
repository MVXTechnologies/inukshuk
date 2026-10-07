import { fromB64uLen, isB64uLen } from './bytes';
import { hasOnlyKeys, isRecord, type Json } from './canonical';
import { canonicalChain, indexOps, type Anchor, type Chain } from './chain';
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
 * `cut = [seq, opId]`: the head of the target's hash chain as the remover saw
 * it. The target's ops with `sq > seq` are rejected (removal) or lose admin
 * authority (demotion) wherever their HLC sorts, and at or below the cut only
 * the chain ending at `opId` counts (`chain.ts`), so a removed member cannot
 * slip in a different op at an old seq either (review H3). Work the target did
 * that the remover had not yet received is dropped: the price of determinism
 * without a server.
 *
 * Only canonical chain ops are folded. Removal cuts are applied in a second
 * pass, because a backdated op sorts before the removal that disqualifies it.
 * Admin cuts can only come from the owner (always authoritative), so they are
 * collected up front from the owner's chain.
 *
 * **Rejected admissions can still leak a key (review H1).** An admit that
 * loses an invite race was still delivered to its joiner with a wrap of the
 * live key. A verified admission rejected for a race-type reason (wraps to
 * exactly the never-member joiner, keys the author holds, first per invite
 * and author) sets `rotationAdvised`; admins rotate. It never blocks writes:
 * the joiner has the key either way, and fail-closed would let any member stop
 * the team. Every other rejected wrap is evidence only (`wrapEvidence`).
 * Removal stays fail-closed (`needsRotation`): only admins can remove.
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
  /** Anyone a wrap reached in a *rejected* op (H1): holders without membership. */
  leaked: Set<string>;
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
  | 'key'
  | 'fork';

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
  /** Valid data ops, in fold order (ephemeral ops are checked on read). */
  data: SignedOp[];
  /** The author's role at each data op's position (review M4: authority is positional). */
  roleAt: Map<string, Role>;
  rejected: Map<string, Rejection>;
  /** Each author's canonical chain (`chain.ts`): the version vector and what peers serve. */
  chains: Map<string, Chain>;
  /** A verified admission that lost still reached its joiner with the newest key. */
  rotationAdvised: boolean;
  /** Counted leaks (one per invite and author), for the admins' rotation policy. */
  leaks: { opId: string; author: string; keyId: string; holder: string }[];
  /** Rejected wrap-carrying ops that did NOT count as leaks: evidence for admins. */
  wrapEvidence: { opId: string; author: string; why: Rejection }[];
  /** The last op folded (incremental appends must sort after it). */
  head?: SignedOp;
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
  removeCuts: ReadonlyMap<string, Anchor>;
  adminCuts: ReadonlyMap<string, Anchor>;
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
    roleAt: new Map(),
    rejected: new Map(),
    chains: new Map(),
    wrapEvidence: [],
    rotationAdvised: false,
    leaks: [],
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

/** `[0]` (nothing seen) or `[seq, opIdAtSeq]`: where the target's history is pinned. */
export function parseCut(value: unknown): Anchor | undefined {
  if (!Array.isArray(value)) return undefined;
  const [seq, id] = value as unknown[];
  if (value.length === 1 && seq === 0) return { seq: 0, id: '', stop: true };
  if (value.length !== 2 || !isInt(seq, 1) || !isB64uLen(id, 32)) return undefined;
  return { seq, id: id as string, stop: true };
}

/** The cut a remover signs: the target's canonical chain head as this peer sees it. */
export function cutFor(s: TeamState, memberId: string): Json {
  const ids = s.chains.get(memberId)?.ids ?? [];
  const head = ids[ids.length - 1];
  return head === undefined ? [0] : [ids.length, head];
}

/** Admin cuts can only be signed by the owner, who is always authoritative. */
function collectAdminCuts(owner: string, ownerOps: readonly SignedOp[]): Map<string, Anchor> {
  const cuts = new Map<string, Anchor>();
  for (const op of ownerOps) {
    if (op.env.t !== 'm.update' && op.env.t !== 'm.remove') continue;
    const b = op.env.b;
    const cut = isRecord(b) ? parseCut(b['cut']) : undefined;
    if (!isRecord(b) || !isMemberId(b['m']) || b['m'] === owner || cut === undefined) continue;
    if (op.env.t === 'm.update' && (b['r'] === undefined || b['r'] === 'admin')) continue;
    const prev = cuts.get(b['m']);
    if (prev === undefined || cut.seq < prev.seq) cuts.set(b['m'], { ...cut, stop: false });
  }
  return cuts;
}

/** A fold in progress: apply canonical ops in total order, then finalize. Resumable. */
export interface Folder {
  state: TeamState;
  removeCuts: Map<string, Anchor>;
  apply(op: SignedOp): void;
  finalize(): void;
}

function makeFolder(ctx: Ctx, genesis: SignedOp): Folder {
  const s = emptyState(ctx.teamId);
  const removeCuts = new Map<string, Anchor>();
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
    leaked: new Set(),
  });
  s.keyOrder.push(k0);
  s.control.push(genesis);
  s.head = genesis;

  const reject = (op: SignedOp, why: Rejection) => {
    s.rejected.set(op.id, why);
  };
  let active = 1;
  const helpers: Helpers = {
    adminOk: (m, sq) => {
      if (!isAdminRole(m.role) || sq <= (m.adminFrom ?? 0)) return false;
      const cut = ctx.adminCuts.get(m.id);
      return m.role === 'owner' || cut === undefined || sq <= cut.seq;
    },
    groupsExist: (links) => links.every((l) => s.groups.has(l.g)),
    wrapsOk: (kw, extra, newKey = false) => {
      const cov = wrapCoverage(kw);
      for (const m of cov.members) {
        if (m !== extra && s.members.get(m)?.status !== 'active') return false;
      }
      if (newKey) return cov.keyIds.size === 1 && !s.keys.has([...cov.keyIds][0]!);
      return [...cov.keyIds].every((k) => s.keys.has(k));
    },
    addRecipients: (kw) => {
      for (const [m, k] of kw.w) s.keys.get(k)?.recipients.add(m);
    },
    activeCount: () => active,
    removeCuts,
  };

  /**
   * H1: a rejected op from an active member may still have handed a key to
   * someone (the loser of an invite race holds a wrap of the live key). Its
   * recipients count as key holders, so the key is unsafe unless they are
   * active members, which forces a rotation.
   */
  const rejectControl = (op: SignedOp, why: Rejection) => {
    reject(op, why);
    const kw = isRecord(op.env.b) ? parseKeyWraps(op.env.b['kw']) : undefined;
    if (kw === undefined) return;
    const slot = plausibleLeak(op, why, kw);
    if (slot === undefined || countedLeaks.has(slot)) {
      // Unverified, re-used or repeated wraps: evidence against the author,
      // never a rotation signal (re-reviews #1 and #3).
      s.wrapEvidence.push({ opId: op.id, author: op.env.au, why });
      return;
    }
    countedLeaks.add(slot);
    for (const [m, k] of kw.w) {
      s.keys.get(k)!.leaked.add(m);
      s.leaks.push({ opId: op.id, author: op.env.au, keyId: k, holder: m });
    }
  };
  /** One counted leak per (invite, author): the rest is evidence. */
  const countedLeaks = new Set<string>();

  /**
   * Only an admission that genuinely lost (a race, a revocation, expiry, a
   * full team, a closed team) by an author who could legitimately admit can
   * have delivered a real key to its joiner. For `m.admit` the invite must
   * exist and the joiner's proof must verify; `m.add` must come from an admin.
   */
  const LEAK_REASONS: readonly Rejection[] = ['invite', 'exists', 'limit', 'expired', 'closed'];
  /**
   * The (invite, author) slot of a rejected admission that may really have
   * handed a key to its joiner, or `undefined`. All of: a race-type reason;
   * an author who could admit (active non-guest with a verified proof against
   * an existing invite, or an admin for `m.add`); wraps addressed to exactly
   * the joiner, who has never been a member; every wrapped key held by the
   * author.
   */
  const plausibleLeak = (op: SignedOp, why: Rejection, kw: KeyWraps): string | undefined => {
    if (!LEAK_REASONS.includes(why)) return undefined;
    const author = s.members.get(op.env.au);
    if (author?.status !== 'active') return undefined;
    let target: unknown;
    let slot: string;
    if (op.env.t === 'm.add') {
      if (!helpers.adminOk(author, op.env.sq) || !isRecord(op.env.b)) return undefined;
      target = op.env.b['m'];
      slot = `add|${op.env.au}`;
    } else if (op.env.t === 'm.admit' && author.role !== 'guest') {
      const proof = parseJoinProof(op.env.b);
      if (proof === undefined || !s.invites.has(proof.inv)) return undefined;
      let ok = ctx.proofCache.get(op.id);
      if (ok === undefined) {
        ok = verifyJoinProof(ctx.c, ctx.teamId, proof);
        ctx.proofCache.set(op.id, ok);
      }
      if (!ok) return undefined;
      target = proof.m;
      slot = `${proof.inv}|${op.env.au}`;
    } else {
      return undefined;
    }
    if (typeof target !== 'string' || s.members.has(target)) return undefined;
    if (!kw.w.every(([m, k]) => m === target && s.keys.get(k)?.recipients.has(op.env.au))) {
      return undefined;
    }
    return slot;
  };

  function apply(op: SignedOp): void {
    if (op === genesis) return;
    s.head = op;
    const { env } = op;
    if (env.t === 'm.genesis') return reject(op, 'duplicate-genesis');
    if (compareOps(op, genesis) < 0) return reject(op, 'before-genesis');
    const cut = ctx.removeCuts.get(env.au);
    if (cut !== undefined && env.sq > cut.seq) return reject(op, 'removed');
    const author = s.members.get(env.au);
    if (author === undefined || author.status !== 'active') {
      return reject(op, author === undefined ? 'not-member' : 'removed');
    }
    if (s.closedAt !== undefined) return rejectControl(op, 'closed');
    if (env.t !== 't.extend' && op.stamp.wall > s.expiresAt) return rejectControl(op, 'expired');
    if (!isControlType(env.t)) {
      const why = dataRejection(s, op, author);
      if (why !== undefined) return reject(op, why);
      s.data.push(op);
      s.roleAt.set(op.id, author.role);
      return;
    }
    const why = applyControl(ctx, s, op, author, helpers);
    if (why !== undefined) return rejectControl(op, why);
    s.control.push(op);
    if (env.t === 'm.add' || env.t === 'm.admit') active++;
    else if (env.t === 'm.remove') active--;
  }

  function finalize(): void {
    const newest = s.keyOrder[s.keyOrder.length - 1];
    const key = newest === undefined ? undefined : s.keys.get(newest);
    // Removal is fail-closed (only admins can remove, so it can't be spammed).
    const unsafe =
      key === undefined || [...key.recipients].some((m) => s.members.get(m)?.status !== 'active');
    s.needsRotation = unsafe;
    s.sendKeyId = unsafe ? undefined : newest;
    // A leak through a rejected admission is ADVISORY (re-review #3): the holder
    // got the key either way, and blocking writes would hand any member a
    // switch to stop the team. Admins rotate (replica auto-rotation, rate-limited).
    s.rotationAdvised =
      key !== undefined && [...key.leaked].some((m) => s.members.get(m)?.status !== 'active');
    s.missingKey =
      key === undefined
        ? []
        : [...s.members.values()]
            .filter((m) => m.status === 'active' && !key.recipients.has(m.id))
            .map((m) => m.id)
            .sort();
  }

  return { state: s, removeCuts, apply, finalize };
}

/** Why a data or ephemeral op from an active `author` is invalid at this point, if it is. */
function dataRejection(s: TeamState, op: SignedOp, author: MemberState): Rejection | undefined {
  const { env } = op;
  if (!canWriteData(author.role, env.t)) return 'forbidden';
  if (env.k !== undefined && !s.keys.get(env.k)?.recipients.has(env.au)) return 'key';
  if (env.x !== undefined && env.x.w.some(([m]) => s.members.get(m)?.status !== 'active')) {
    return 'unknown-target';
  }
  const aud = env.aud === undefined ? undefined : parseAudience(env.aud);
  if (env.pr !== undefined && !canUsePriority(author, env.pr, aud, s.groups)) return 'forbidden';
  return undefined;
}

/**
 * Ephemeral ops (positions) stay out of the fold (review M2): they are checked
 * against the current resolved state when read, with the data-op rules.
 */
export function admitEphemeral(s: TeamState, op: SignedOp): boolean {
  const author = s.members.get(op.env.au);
  if (author?.status !== 'active' || s.closedAt !== undefined) return false;
  if (op.stamp.wall > s.expiresAt) return false;
  return dataRejection(s, op, author) === undefined;
}

interface Helpers {
  adminOk: (m: MemberState, sq: number) => boolean;
  groupsExist: (links: readonly GroupLink[]) => boolean;
  wrapsOk: (kw: KeyWraps, extra?: string, newKey?: boolean) => boolean;
  addRecipients: (kw: KeyWraps) => void;
  activeCount: () => number;
  removeCuts: Map<string, Anchor>;
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
      const cut = b['cut'] === undefined ? undefined : parseCut(b['cut']);
      if (b['cut'] !== undefined && cut === undefined) return 'invalid-body';
      if (b['from'] !== undefined && !isInt(b['from'])) return 'invalid-body';
      const target = s.members.get(b['m']);
      if (target === undefined || target.status !== 'active') return 'unknown-target';
      if (!admin || !canManage(author.role, target.role)) return 'forbidden';
      if (role !== undefined && !canGrantRole(author.role, role)) return 'forbidden';
      if (groups && !h.groupsExist(groups)) return 'unknown-target';
      if (role !== undefined && role !== target.role) {
        const demotingAdmin = target.role === 'admin' && role !== 'admin';
        if (demotingAdmin && cut === undefined) return 'invalid-body';
        if (role === 'admin' && target.adminCut !== undefined) return 'forbidden';
        if (demotingAdmin) target.adminCut = cut!.seq;
        if (role === 'admin') target.adminFrom = (b['from'] as number | undefined) ?? 0;
        target.role = role;
      }
      if (groups) target.groups = groups;
      return undefined;
    }
    case 'm.remove': {
      const b = body(op, ['m', 'cut']);
      const cut = parseCut(b?.['cut']);
      if (!b || !isMemberId(b['m']) || cut === undefined) return 'invalid-body';
      const target = s.members.get(b['m']);
      if (target === undefined || target.status !== 'active') return 'unknown-target';
      if (!admin || !canManage(author.role, target.role)) return 'forbidden';
      target.status = 'removed';
      target.removedAt = stamp;
      target.removeCut = cut.seq;
      if (target.role === 'admin') target.adminCut = cut.seq;
      h.removeCuts.set(target.id, cut);
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
        leaked: new Set(),
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
 * Resolve the team from every logged op we hold (any order, duplicates and
 * forks allowed). Pure and deterministic. Ops must already have passed
 * `checkEnvelope` for this team. Ephemeral ops are ignored here (see
 * {@link admitEphemeral}).
 *
 * Only each author's canonical chain is folded (`chain.ts`). Pass A finds the
 * valid removals; pass B anchors the removed members' chains at their cuts
 * and refolds, so backdated or forked ops are rejected wherever they sort.
 */
export function resolveTeam(
  c: TeamCrypto,
  teamId: string,
  ops: readonly SignedOp[],
  options: ResolveOptions = {},
): TeamState {
  return resolve(c, teamId, ops, options).state;
}

/** {@link resolveTeam}, keeping the folder so later ops can be appended ({@link canAppend}). */
export function resolveFolder(
  c: TeamCrypto,
  teamId: string,
  ops: readonly SignedOp[],
  options: ResolveOptions = {},
): { state: TeamState; folder?: Folder } {
  return resolve(c, teamId, ops, options);
}

function resolve(
  c: TeamCrypto,
  teamId: string,
  ops: readonly SignedOp[],
  options: ResolveOptions,
): { state: TeamState; folder?: Folder } {
  const index = indexOps(ops);
  const all: SignedOp[] = [];
  for (const a of index.authors) {
    const top = index.maxSeq(a);
    for (let sq = 1; sq <= top; sq++) for (const op of index.candidates(a, sq)) all.push(op);
  }
  const genesis = pickGenesis(c, teamId, all);
  if (genesis === undefined) {
    const s = emptyState(teamId);
    for (const op of all) s.rejected.set(op.id, 'no-genesis');
    return { state: s };
  }
  const owner = genesis.env.au;
  // The owner's chain starts at the chosen genesis: a second genesis the owner
  // signed is a fork of their chain, never an alternative history.
  const genesisAnchor: Anchor = { seq: 1, id: genesis.id, stop: false };
  const ownerOps = canonicalChain(index, owner, genesisAnchor).ids.map((id) => index.get(id)!);
  const adminCuts = collectAdminCuts(owner, ownerOps);
  const proofCache = options.proofCache ?? new Map<string, boolean>();

  const run = (removeCuts: Map<string, Anchor>): Folder => {
    const chains = new Map<string, Chain>();
    for (const a of index.authors) {
      const anchor = a === owner ? genesisAnchor : (removeCuts.get(a) ?? adminCuts.get(a));
      chains.set(a, canonicalChain(index, a, anchor));
    }
    const canonical = new Set([...chains.values()].flatMap((ch) => ch.ids));
    const folder = makeFolder({ c, teamId, removeCuts, adminCuts, proofCache }, genesis);
    folder.state.chains = chains;
    for (const op of all) {
      if (canonical.has(op.id)) continue;
      const cut = removeCuts.get(op.env.au);
      folder.state.rejected.set(
        op.id,
        cut !== undefined && op.env.sq > cut.seq ? 'removed' : 'fork',
      );
    }
    for (const op of all.filter((o) => canonical.has(o.id)).sort(compareOps)) folder.apply(op);
    folder.finalize();
    return folder;
  };
  let folder = run(new Map());
  if (folder.removeCuts.size > 0) {
    const cuts = folder.removeCuts;
    folder = run(cuts);
    // Pass B's own removals are re-collected; keep enforcing pass A's (stable, see header).
    for (const [k, v] of cuts) folder.removeCuts.set(k, v);
  }
  return { state: folder.state, folder };
}

/**
 * Whether `op` can be appended to a resolved fold without refolding (review
 * M2): it sorts after everything folded so far, extends its author's
 * canonical chain by exactly one, and cannot change anything retroactively
 * (no genesis, removal, role change or anchored author).
 */
export function canAppend(
  state: TeamState,
  op: SignedOp,
  head = state.head,
  ids: readonly string[] = state.chains.get(op.env.au)?.ids ?? [],
): boolean {
  const { env } = op;
  if (head === undefined || compareOps(op, head) <= 0) return false;
  if (env.sq === 0 || env.t === 'm.genesis' || env.t === 'm.remove' || env.t === 'm.update') {
    return false;
  }
  const member = state.members.get(env.au);
  if (member?.removeCut !== undefined || member?.adminCut !== undefined) return false;
  return env.sq === ids.length + 1 && env.pv === ids[ids.length - 1];
}

/** Append ops that each passed {@link canAppend} (in order), then finalize once. */
export function appendOps(folder: Folder, ops: readonly SignedOp[]): void {
  const chains = folder.state.chains;
  for (const op of ops) {
    const ch = chains.get(op.env.au) ?? { ids: [], pinned: new Map<number, string>() };
    ch.ids.push(op.id);
    chains.set(op.env.au, ch);
    folder.apply(op);
  }
  folder.finalize();
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
