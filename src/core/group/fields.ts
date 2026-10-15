import type { Json } from '@core/team/canonical';
import { own, type EntityState } from '@core/team/crdt';

/**
 * Field rules shared by the 2.7.0 group-level kinds (`gmeta`, and the team's
 * `gref` / `irdv` / `net`).
 *
 * These kinds are **forward-lenient**: each known field is checked strictly,
 * but a field this version does not know is accepted (its name is already
 * checked by the fold). A 2.7.0 phone must not drop a 2.7.x record because it
 * gained a field (the lesson of `validCapFields`, #683).
 */

/** An app / domain token, as in `gmeta.app` and `gref.app`. */
export const APP_TOKEN = /^[a-z]{1,8}$/;

export type FieldRule = (v: Json) => boolean;

export const flag: FieldRule = (v) => v === 0 || v === 1;

export const text =
  (max: number): FieldRule =>
  (v) =>
    typeof v === 'string' && v.trim().length > 0 && v.length <= max;

export const app: FieldRule = (v) => typeof v === 'string' && APP_TOKEN.test(v);

/** Every known field passes its rule; unknown fields are left alone (forward-lenient). */
export function knownFieldsValid(
  f: Readonly<Record<string, Json>>,
  rules: Readonly<Record<string, FieldRule>>,
): boolean {
  return Object.entries(f).every(([k, v]) => {
    const rule = own(rules, k);
    return rule === undefined || rule(v);
  });
}

export const has = (f: Readonly<Record<string, Json>>, k: string): boolean =>
  Object.prototype.hasOwnProperty.call(f, k);

/**
 * Whether the write changes a write-once field the record already holds
 * (another value than the one it has: a rewrite of the same value is fine).
 */
export function rewritesOnce(
  cur: EntityState | undefined,
  f: Readonly<Record<string, Json>>,
  once: readonly string[],
): boolean {
  if (cur === undefined) return false;
  return once.some((k) => {
    if (!has(f, k)) return false;
    const reg = own(cur.fields, k);
    return reg !== undefined && reg.value !== f[k];
  });
}
