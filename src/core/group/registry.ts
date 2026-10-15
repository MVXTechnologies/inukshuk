import type { Json } from '@core/team/canonical';
import type { EntityState } from '@core/team/crdt';
import type { EntityRecord, TeamData } from '@core/team/data';
import type { TeamState } from '@core/team/membership';
import type { Role } from '@core/team/roles';

/**
 * Domain plug-ins of a sync group (2.7.0, `docs/design/sync-layer.md` §5).
 *
 * A **sync group** is what the protocol code calls a team: one op log, one
 * membership, one keyring. What the group's data *means* is up to the
 * domains it hosts: the team domain (positions, pins, SOS, trails, tasks,
 * drawings…), later the shared library (#712). The data fold dispatches each
 * `e.set` / `e.del` by its kind to the plug-in that registered the kind; a
 * kind nobody registered is skipped (stored, relayed, chain intact), which is
 * how a phone ignores a newer app's records.
 *
 * Wire bytes are unchanged: kinds, fields, envelopes and labels stay v1.
 */

/** A group id: the team id derivation, unchanged (16 bytes, base64url). */
export type GroupId = string;

/** The per-group data view the fold builds (the team view's shape, shared by every domain). */
export type GroupData = TeamData;
/** What a plug-in may read while authorizing: the view folded so far. */
export type DomainState = GroupData;

/** A link lane (§4.4): 0 urgent, 1 live, 2 sync, 3 bulk. */
export type Lane = 0 | 1 | 2 | 3;

/** Ephemeral op types a domain may consume (cap-gated on the wire; `ev` is specified, not built). */
export type EphemeralKind = 'pos' | 'pen' | 'ev';

/** One decoded `e.set` / `e.del` at its place in the fold, as a plug-in sees it. */
export interface KindWrite {
  op: 'set' | 'del';
  kind: string;
  id: string;
  /** The written fields (`{}` for a delete). */
  f: Readonly<Record<string, Json>>;
  /** `o`: whose record this names (absent: the author's own). */
  o: string | undefined;
  /** The author's member id. */
  author: string;
  /** The op's stamp wall (ms): rules that depend on time read it, never a clock. */
  wall: number;
}

/**
 * A plug-in's verdict on a write. `invalid`: malformed (skipped as such).
 * `forbidden`: well formed, but not this author's to write at this point of
 * the fold. Otherwise the owner to key the record under (`undefined` for a
 * shared record).
 */
export type Authorization = 'invalid' | 'forbidden' | { readonly owner: string | undefined };

export interface DomainPlugin<View = unknown> {
  /** `team`, `lib`, `self`…; matches `gmeta.app` for the group's main domain. */
  readonly id: string;
  /** The `e.set` / `e.del` kinds it owns (unique across a registry; checked at registration). */
  readonly kinds: readonly string[];
  /** `msg` thread prefixes it owns (`team`, `pin`, `trail`…): declarative in 2.7.0. */
  readonly threads?: readonly string[];
  /** Ephemeral op types it consumes. */
  readonly ephemeral?: readonly EphemeralKind[];
  /**
   * Entity key policy: an owned kind is keyed `(kind, owner, id)`, so nobody
   * takes over someone's record by writing to its id; a shared one `(kind, id)`.
   */
  owned(kind: string): boolean;
  /**
   * Shape check of the write itself, before any role is looked at (which
   * kinds take `o`, which can be written at all). Total; false = `invalid`.
   */
  validate(w: KindWrite): boolean;
  /**
   * Authorization at the op's fold position (the author's role then), with
   * the view folded so far. Field validation lives here too, in the order the
   * domain needs. Total; never throws on hostile input.
   */
  authorize(w: KindWrite, role: Role, view: Readonly<DomainState>): Authorization;
  /** After a record of one of its kinds merged: keep the domain's counters in step. */
  merged?(view: DomainState, rec: Readonly<EntityRecord>, before: EntityState | undefined): void;
  /** Merge is always per-field LWW (`mergeEntity`); a domain may opt into base stamps (§4.3). */
  readonly baseStamps?: boolean;
  /** Derived, memoised view for features (pure). */
  view?(data: Readonly<DomainState>, group: Readonly<TeamState>, now: number): View;
  /** Lane for an outgoing op of this kind (default 1 when pushed live). */
  lane?(kind: string, fields: Readonly<Record<string, Json>>): Lane;
  /** Capabilities a peer must advertise before this domain sends it gated things. */
  readonly needsCaps?: readonly string[];
}

/** What the fold needs from a registry. */
export interface DomainLookup {
  /** The plug-in that owns `kind`, or `undefined`: skip the op as `unknown` (a newer app's kind). */
  forKind(kind: string): DomainPlugin | undefined;
}

/**
 * Kind names: 1–8 lowercase letters. Every v1 kind fits (`comment` is the
 * longest); the design's "≤ 4 chars" is the guideline for NEW kinds, which
 * each cost bytes in every op that carries them.
 */
export const KIND_NAME = /^[a-z]{1,8}$/;
/** Thread prefixes and domain ids: the same alphabet as a `msg` thread's head. */
const TOKEN = /^[a-z]{1,8}$/;

/** The entity key of a record: `(kind, owner, id)` for an owned kind, `(kind, id)` for a shared one. */
export function recordKey(owned: boolean, kind: string, id: string, owner?: string): string {
  return owned ? `${kind}:${owner ?? ''}:${id}` : `${kind}:${id}`;
}

/**
 * The plug-ins one group's fold dispatches to. Registration errors are
 * programmer errors (a kind claimed twice would make the fold depend on
 * registration order), so they throw; lookups are total. A registry is
 * frozen once shared ({@link DomainRegistry.freeze}): a fold cache built
 * under it must never see its rules change.
 */
export class DomainRegistry implements DomainLookup {
  private readonly byKind = new Map<string, DomainPlugin>();
  private readonly byThread = new Map<string, DomainPlugin>();
  private readonly byId = new Map<string, DomainPlugin>();
  private frozen = false;

  constructor(plugins: readonly DomainPlugin[] = []) {
    for (const p of plugins) this.register(p);
  }

  register(p: DomainPlugin): void {
    if (this.frozen) throw new Error(`registry is frozen: cannot register '${p.id}'`);
    if (!TOKEN.test(p.id)) throw new Error(`bad domain id '${p.id}'`);
    if (this.byId.has(p.id)) throw new Error(`domain '${p.id}' registered twice`);
    const kinds = new Set<string>();
    for (const k of p.kinds) {
      if (!KIND_NAME.test(k)) throw new Error(`bad kind '${k}' in domain '${p.id}'`);
      const other = this.byKind.get(k);
      if (other !== undefined || kinds.has(k))
        throw new Error(`kind '${k}' claimed by '${other?.id ?? p.id}' and '${p.id}'`);
      kinds.add(k);
    }
    const threads = new Set<string>();
    for (const t of p.threads ?? []) {
      if (!TOKEN.test(t)) throw new Error(`bad thread prefix '${t}' in domain '${p.id}'`);
      const other = this.byThread.get(t);
      if (other !== undefined || threads.has(t))
        throw new Error(`thread '${t}' claimed by '${other?.id ?? p.id}' and '${p.id}'`);
      threads.add(t);
    }
    this.byId.set(p.id, p);
    for (const k of kinds) this.byKind.set(k, p);
    for (const t of threads) this.byThread.set(t, p);
  }

  /** No more registrations (a shared registry is frozen before any fold uses it). */
  freeze(): this {
    this.frozen = true;
    return this;
  }

  get isFrozen(): boolean {
    return this.frozen;
  }

  forKind(kind: string): DomainPlugin | undefined {
    return this.byKind.get(kind);
  }

  /** The plug-in owning a `msg` thread (`pin:<owner>:<id>` → `pin`), if any. */
  forThread(thread: string): DomainPlugin | undefined {
    const i = thread.indexOf(':');
    return this.byThread.get(i < 0 ? thread : thread.slice(0, i));
  }

  plugin(id: string): DomainPlugin | undefined {
    return this.byId.get(id);
  }

  plugins(): readonly DomainPlugin[] {
    return [...this.byId.values()];
  }

  /** Every registered kind, sorted. */
  kinds(): readonly string[] {
    return [...this.byKind.keys()].sort();
  }
}
