import type { TeamData } from '@core/team/data';
import { isAdminRole, type Role } from '@core/team/roles';

import { has, knownFieldsValid, rewritesOnce, type FieldRule } from './fields';
import { recordKey, type Authorization, type KindWrite } from './registry';

/**
 * A table of simple 2.7.0 record kinds (the group's `irdv` / `net`, the
 * team's `gref`): each kind's key policy, writers, id check, field rules,
 * first-write field and write-once fields. Forward-lenient (`fields.ts`).
 *
 * Deletes: an owned record by its writer or an admin (`o` names whose);
 * a shared record by admins only.
 */
export interface KindSpec {
  owned: boolean;
  /** Who may write it. */
  writes: (role: Role) => boolean;
  /** Checks of the write's id. */
  id: (id: string) => boolean;
  rules: Readonly<Record<string, FieldRule>>;
  /** The field its first write must carry. */
  first: string;
  /** Fields a later write may repeat, never change. */
  once: readonly string[];
}

export class KindTable {
  private readonly specs: ReadonlyMap<string, KindSpec>;

  constructor(specs: Readonly<Record<string, KindSpec>>) {
    this.specs = new Map(Object.entries(specs));
  }

  get kinds(): readonly string[] {
    return [...this.specs.keys()];
  }

  has(kind: string): boolean {
    return this.specs.has(kind);
  }

  owned(kind: string): boolean {
    return this.specs.get(kind)?.owned === true;
  }

  /** Shape of the write itself, before any role: its id, and `o` only on an owned kind's delete. */
  validate(w: KindWrite): boolean {
    const spec = this.specs.get(w.kind);
    if (spec === undefined || !spec.id(w.id)) return false;
    return w.o === undefined || (w.op === 'del' && spec.owned);
  }

  /** Authorization of a write of one of its kinds, validated by {@link validate}. */
  authorize(w: KindWrite, role: Role, view: Readonly<TeamData>): Authorization {
    const spec = this.specs.get(w.kind);
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
}
