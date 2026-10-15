/**
 * What the placed fields need, as one union (mockup §8 "one coordinator"):
 * the UI subscribes to exactly these deps, at the fastest clock any field
 * asks for, and to nothing else. A strip of coordinates and elevation never
 * starts the compass; a strip without ETE never runs the moving-speed window.
 */
import { fieldDescriptor } from './registry';
import type { DataDep, FieldRef, Params } from './types';

/** The clock periods a strip can ask for, ms. */
export const SECOND_MS = 1000;
export const MINUTE_MS = 60_000;

export interface StripNeeds {
  /** The union of the known placed fields' deps. */
  deps: ReadonlySet<DataDep>;
  /**
   * The clock's period: each second for a `second` field, each minute for a
   * `minute` field or one that reads the clock, else null (no timer at all).
   */
  clockMs: number | null;
  /** Whether a field shows ETE/ETA (the 10-minute moving-speed window runs only then). */
  movingSpeed: boolean;
}

/** The fields whose compute() reads `movingSpeedMps`. */
const MOVING_SPEED_FIELDS: ReadonlySet<string> = new Set(['ete', 'eta']);

/** The union of what `rows`' known fields need with their params (unknown ids need nothing). */
export function stripNeeds(rows: readonly (readonly FieldRef[])[]): StripNeeds {
  const deps = new Set<DataDep>();
  let second = false;
  let minute = false;
  let movingSpeed = false;
  for (const row of rows) {
    for (const f of row) {
      const d = fieldDescriptor(f.field);
      if (d === undefined) continue;
      // Param-aware: what the field reads as it is set up, not all it could.
      const own = d.depsFor?.(f.params as Params) ?? d.deps;
      for (const dep of own) deps.add(dep);
      if (d.tick === 'second') second = true;
      if (d.tick === 'minute' || d.deps.includes('clock')) minute = true;
      if (MOVING_SPEED_FIELDS.has(d.id)) movingSpeed = true;
    }
  }
  return { deps, clockMs: second ? SECOND_MS : minute ? MINUTE_MS : null, movingSpeed };
}

/**
 * Whether a strip reads the live centre cursor: MapScreen asks the map for
 * gesture-rate camera reports only then (a boolean, so its selector re-renders
 * MapScreen only when a cursor field is placed or removed).
 */
export function stripReadsCursor(rows: readonly (readonly FieldRef[])[]): boolean {
  return rows.some((row) => row.some((f) => fieldDescriptor(f.field)?.deps.includes('cursor')));
}
