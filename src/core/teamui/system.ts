/**
 * System messages (#589 UI): facts every member needs that the frozen v1
 * protocol has no op for, carried as ordinary `msg` ops on `sys:` threads.
 *
 * - `sys:profile` — a member's display name. `m.admit` carries no name (the
 *   admitting phone doesn't know it) and guests cannot write entities, but
 *   every role may post messages. Newest wins per author.
 * - `sys:team` — the team's name, re-posted by an admin under each new team
 *   key. The genesis labels hold it too, but they are sealed under key 0, which
 *   a member admitted after a rotation never receives.
 * - `sys:leave` — "I deleted this team from my phone": the protocol has no
 *   self-removal (only an admin can remove, which rotates the key), so this
 *   tells the admins to do it.
 *
 * A `sys:` message is never shown in the chat and never notifies.
 * The body text is canonical JSON-ish `{"n":"…"}` so a later version can add
 * fields; anything unparsable is ignored.
 */
import type { Json } from '@core/team/canonical';

export const SYS_PROFILE = 'sys:profile';
export const SYS_TEAM = 'sys:team';
export const SYS_LEAVE = 'sys:leave';

/** Display names: 1–40 characters after trimming and collapsing whitespace. */
export const MAX_NAME_CHARS = 40;

export function isSystemThread(thread: string): boolean {
  return thread.startsWith('sys:');
}

// C0 controls, DEL, zero-width and bidi-override characters (a name must not reorder the UI).
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g;

/** Trim, collapse whitespace, strip control characters, cap the length. Empty → null. */
export function cleanName(raw: string): string | null {
  const text = raw.replace(CONTROL_CHARS, '');
  const name = text.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_CHARS).trim();
  return name.length > 0 ? name : null;
}

export function nameText(name: string): string {
  return JSON.stringify({ n: name });
}

/** The name in a `sys:profile` / `sys:team` body, or null. Total. */
export function parseNameText(text: unknown): string | null {
  if (typeof text !== 'string' || text.length > 400) return null;
  try {
    const v = JSON.parse(text) as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    const n = (v as Record<string, unknown>)['n'];
    return typeof n === 'string' ? cleanName(n) : null;
  } catch {
    return null;
  }
}

/** The `msg` body for a system message (the caller supplies a fresh short id). */
export function systemMessage(id: string, thread: string, payload: Json): Json {
  return { id, th: thread, tx: typeof payload === 'string' ? payload : JSON.stringify(payload) };
}
