import { isRecord } from './canonical';
import { isMemberId, isShortId } from './ids';

/**
 * Roles, the group hierarchy and audiences (#589, owner B4: "100+ members,
 * with hierarchies and roles controlling who gets which message").
 *
 * Two orthogonal axes:
 * - **Role** = authority, a strict ladder: `owner` (the team creator, exactly
 *   one) > `admin` > `member` > `guest`. Only owner/admins sign membership.
 * - **Groups** = the org chart, a tree (e.g. "Sector A" → "Team A2"). A member
 *   belongs to any number of groups and may be a **lead** of each. Groups are
 *   only for targeting and notification; they grant no authority.
 *
 * An {@link Audience} selects recipients by explicit member ids, roles, group
 * subtrees and/or "leads only". It is metadata for routing and notification;
 * confidentiality for a narrow audience comes from sealed encryption
 * (`envelope.ts`), not from the audience field.
 */
export const ROLES = ['guest', 'member', 'admin', 'owner'] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function roleRank(role: Role): number {
  return ROLES.indexOf(role);
}

export const isAdminRole = (role: Role): boolean => roleRank(role) >= roleRank('admin');

/** Roles `actor` may hand out (via add, update or an invite). Nobody can mint an owner. */
export function canGrantRole(actor: Role, granted: Role): boolean {
  if (actor === 'owner') return granted !== 'owner';
  if (actor === 'admin') return granted === 'member' || granted === 'guest';
  return false;
}

/** Whether `actor` may change or remove a member currently holding `target`. */
export function canManage(actor: Role, target: Role): boolean {
  if (actor === 'owner') return target !== 'owner';
  if (actor === 'admin') return target === 'member' || target === 'guest';
  return false;
}

/**
 * Data op types a guest may author; members and up may author all of them.
 * Guests "only comment": entity writes are let through here and narrowed to
 * their own `comment` records by the data fold (`data.ts`, `GUEST_KINDS`).
 */
const GUEST_TYPES: readonly string[] = ['pos', 'msg', 'e.set', 'e.del'];

export function canWriteData(role: Role, type: string): boolean {
  return roleRank(role) >= roleRank('member') || GUEST_TYPES.includes(type);
}

// ── Groups ──────────────────────────────────────────────────────────────────

export const MAX_GROUPS = 256;
export const MAX_GROUP_DEPTH = 8;
export const MAX_GROUPS_PER_MEMBER = 16;

/** A member's place in one group. */
export interface GroupLink {
  g: string;
  lead?: true;
}

/** Group id → parent id (`undefined` = top level). */
export type GroupTree = ReadonlyMap<string, string | undefined>;

export function parseGroupLinks(value: unknown): GroupLink[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_GROUPS_PER_MEMBER) return undefined;
  const seen = new Set<string>();
  const out: GroupLink[] = [];
  for (const item of value as unknown[]) {
    if (!isRecord(item) || !isShortId(item['g']) || seen.has(item['g'])) return undefined;
    if (item['lead'] !== undefined && item['lead'] !== true) return undefined;
    if (Object.keys(item).some((k) => k !== 'g' && k !== 'lead')) return undefined;
    seen.add(item['g']);
    out.push(item['lead'] === true ? { g: item['g'], lead: true } : { g: item['g'] });
  }
  return out;
}

/** True when `ancestor` is `group` or one of its parents. Bounded walk (no cycle can hang it). */
export function isWithin(tree: GroupTree, group: string, ancestor: string): boolean {
  let cur: string | undefined = group;
  for (let i = 0; cur !== undefined && i <= MAX_GROUP_DEPTH; i++) {
    if (cur === ancestor) return true;
    cur = tree.get(cur);
  }
  return false;
}

/** Depth of `group` (top level = 1), or Infinity for a broken chain. */
export function groupDepth(tree: GroupTree, group: string): number {
  let cur: string | undefined = group;
  for (let d = 1; d <= MAX_GROUP_DEPTH + 1; d++) {
    if (!tree.has(cur!)) return Infinity;
    cur = tree.get(cur!);
    if (cur === undefined) return d;
  }
  return Infinity;
}

/** Whether setting `group`'s parent to `parent` keeps the tree acyclic and shallow enough. */
export function canSetParent(tree: GroupTree, group: string, parent: string | undefined): boolean {
  if (parent === undefined) return true;
  if (!tree.has(parent) || isWithin(tree, parent, group)) return false;
  const next = new Map(tree);
  next.set(group, parent);
  // Every group under `group` gets deeper too.
  return [...next.keys()].every(
    (g) => !isWithin(next, g, group) || groupDepth(next, g) <= MAX_GROUP_DEPTH,
  );
}

// ── Audiences ───────────────────────────────────────────────────────────────

export const MAX_AUDIENCE_MEMBERS = 256;
export const MAX_AUDIENCE_GROUPS = 32;

export interface Audience {
  /** Explicit member ids. */
  m?: string[];
  /** Every member holding one of these roles. */
  r?: Role[];
  /** Every member of these groups or their subgroups. */
  g?: string[];
  /** Narrow `g` to the groups' leads; alone, every lead of any group. */
  l?: true;
}

const sortedUnique = <T extends string>(xs: readonly T[]): T[] => [...new Set(xs)].sort();

/** Strict parse; `undefined` = invalid. A canonical audience has sorted, unique lists. */
export function parseAudience(value: unknown): Audience | undefined {
  if (!isRecord(value) || Object.keys(value).some((k) => !['m', 'r', 'g', 'l'].includes(k))) {
    return undefined;
  }
  const out: Audience = {};
  const { m, r, g, l } = value;
  if (m !== undefined) {
    if (!Array.isArray(m) || m.length === 0 || m.length > MAX_AUDIENCE_MEMBERS) return undefined;
    if (!m.every(isMemberId)) return undefined;
    out.m = sortedUnique(m as string[]);
  }
  if (r !== undefined) {
    if (!Array.isArray(r) || r.length === 0 || !r.every(isRole)) return undefined;
    out.r = sortedUnique(r as Role[]);
  }
  if (g !== undefined) {
    if (!Array.isArray(g) || g.length === 0 || g.length > MAX_AUDIENCE_GROUPS) return undefined;
    if (!g.every(isShortId)) return undefined;
    out.g = sortedUnique(g as string[]);
  }
  if (l !== undefined) {
    if (l !== true) return undefined;
    out.l = true;
  }
  if (out.m === undefined && out.r === undefined && out.g === undefined && out.l === undefined) {
    return undefined; // "everyone" is spelled by omitting the audience
  }
  return out;
}

/** What audience matching needs to know about a member. */
export interface AudienceSubject {
  id: string;
  role: Role;
  groups: readonly GroupLink[];
}

/**
 * Whether `subject` is in the audience. No audience = the whole team. The
 * selectors are a union: explicit id OR role OR (group subtree [∧ lead]).
 */
export function inAudience(
  aud: Audience | undefined,
  subject: AudienceSubject,
  tree: GroupTree,
): boolean {
  if (aud === undefined) return true;
  if (aud.m?.includes(subject.id)) return true;
  if (aud.r?.includes(subject.role)) return true;
  const links = subject.groups.filter((link) => tree.has(link.g));
  if (aud.g !== undefined) {
    return links.some(
      (link) =>
        (aud.l !== true || link.lead === true) && aud.g!.some((g) => isWithin(tree, link.g, g)),
    );
  }
  if (aud.l === true) return links.some((link) => link.lead === true);
  return false;
}

export const PRIORITIES = [0, 1, 2] as const;
/** 0 normal, 1 important, 2 urgent (bypasses notification throttling). */
export type Priority = (typeof PRIORITIES)[number];

/**
 * Who may raise a message's priority:
 * - important (1): members and up;
 * - urgent (2): admins/owner to anyone; a group lead only to an audience made
 *   purely of groups they lead (their own subtree).
 */
export function canUsePriority(
  sender: AudienceSubject,
  priority: Priority,
  aud: Audience | undefined,
  tree: GroupTree,
): boolean {
  if (priority === 0) return true;
  if (sender.role === 'guest') return false;
  if (priority === 1 || isAdminRole(sender.role)) return true;
  if (aud?.g === undefined || aud.m !== undefined || aud.r !== undefined) return false;
  const led = sender.groups.filter((link) => link.lead === true && tree.has(link.g));
  return aud.g.every((g) => led.some((link) => isWithin(tree, g, link.g)));
}
