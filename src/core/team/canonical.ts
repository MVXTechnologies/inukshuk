/**
 * Canonical JSON for the team protocol (#589): the bytes that get signed,
 * hashed and AEAD-bound. It is the RFC 8785 (JCS) subset we need:
 *
 * - object keys sorted by UTF-16 code units (JS default sort), no whitespace;
 * - numbers in ECMAScript `Number.prototype.toString` form (what JCS mandates);
 *   only finite numbers; `-0` is written `0`;
 * - strings as `JSON.stringify` writes them;
 * - `undefined` object members are omitted (optional fields), anything else
 *   that is not JSON (functions, bigint, NaN, typed arrays, cycles) makes the
 *   whole value non-canonical → `undefined`.
 *
 * Binary values never appear raw: they are base64url strings (`bytes.ts`).
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Nesting deeper than this is refused (stack-safety against hostile input). */
export const MAX_JSON_DEPTH = 16;

function enc(value: unknown, depth: number): string | undefined {
  if (depth > MAX_JSON_DEPTH) return undefined;
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) return undefined;
      return Object.is(value, -0) ? '0' : String(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        const parts: string[] = [];
        for (const item of value as unknown[]) {
          const e = enc(item, depth + 1);
          if (e === undefined) return undefined;
          parts.push(e);
        }
        return `[${parts.join(',')}]`;
      }
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) return undefined; // Uint8Array, Map, Date…
      const rec = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(rec).sort()) {
        const v = rec[key];
        if (v === undefined) continue;
        const e = enc(v, depth + 1);
        if (e === undefined) return undefined;
        parts.push(`${JSON.stringify(key)}:${e}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      return undefined;
  }
}

/** The canonical text of a JSON value, or `undefined` if it is not plain JSON. */
export function canonicalize(value: unknown): string | undefined {
  return enc(value, 0);
}

function depthOk(value: unknown, depth: number): boolean {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value !== 'object') return true;
  const items = Array.isArray(value) ? value : Object.values(value as object);
  return (items as unknown[]).every((v) => depthOk(v, depth + 1));
}

/**
 * Parse untrusted JSON text. Total: `undefined` for invalid text or nesting
 * deeper than {@link MAX_JSON_DEPTH}. Callers must still validate the shape.
 */
export function parseJson(text: string): Json | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return depthOk(value, 0) ? (value as Json) : undefined;
}

/** Narrow to a plain JSON object (not array, not null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * True when `value` has only keys from `allowed` — envelopes and bodies
 * reject unknown members so that two encodings of "the same" op cannot both
 * verify.
 */
export function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((k) => allowed.includes(k));
}
