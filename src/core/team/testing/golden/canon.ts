/**
 * TEST-ONLY: a canonical, comparable text of one replica's folded view (the
 * golden refold gate of the sync-group seam, 2.7.0 PR G1).
 *
 * Covers what a feature can observe: the membership summary, every entity
 * record (kind, id, owner, audience, priority, per-field registers and
 * stamps), the positions, the skipped ops with their reason, and the record
 * index the fold keeps. Maps and sets are sorted; object keys are sorted;
 * `undefined` members are dropped, so two folds that agree give the same text
 * whatever order they inserted things in.
 */
import type { TeamData } from '../../data';
import type { TeamState } from '../../membership';

function stable(value: unknown): unknown {
  if (value instanceof Map) {
    return [...value.entries()]
      .map(([k, v]) => [k, stable(v)] as const)
      .sort(([a], [b]) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
  }
  if (value instanceof Set) return [...value].map(stable).sort();
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = stable(v);
    }
    return out;
  }
  return value;
}

export interface CanonicalView {
  members: unknown;
  entities: unknown;
  positions: unknown;
  skipped: unknown;
  index: unknown;
}

/** The canonical view of a data fold (plus the membership it was folded under). */
export function canonicalView(state: TeamState, data: TeamData): CanonicalView {
  const members = [...state.members.values()]
    .map((m) => [m.id, m.role, m.status, m.removeCut ?? null] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const skipped = [...data.skipped].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : a.why < b.why ? -1 : a.why > b.why ? 1 : 0,
  );
  return stable({
    members,
    entities: data.entities,
    positions: data.positions,
    skipped,
    index: data.index,
  }) as CanonicalView;
}

export function canonicalText(state: TeamState, data: TeamData): string {
  return JSON.stringify(canonicalView(state, data));
}
