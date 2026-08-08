/**
 * Shared vocabulary for the cloud-sync engine (M0 — pure data model, no
 * network). Sync v1 scope is traces + photos + the small library-meta blob
 * (folders/waypoints/categories); map PDFs are a later milestone.
 *
 * These types are deliberately standalone: nothing in `@core/models` or the
 * `library.json` schema is touched. Integration is a later thin adapter — see
 * the schema note in `./state.ts`.
 */

/** The syncable collections of sync v1, mirroring the planned server collections. */
export const SYNC_KINDS = ['track', 'photo', 'libraryMeta'] as const;

/** One syncable collection: a trail (GPX + summary), a note photo, or the library-meta blob. */
export type SyncKind = (typeof SYNC_KINDS)[number];

/** Type guard for {@link SyncKind} — used when sanitizing persisted sync state. */
export function isSyncKind(value: unknown): value is SyncKind {
  return typeof value === 'string' && (SYNC_KINDS as readonly string[]).includes(value);
}

/** Identifies one syncable item across collections. */
export interface ItemRef {
  kind: SyncKind;
  /** The item's client id (`newId()` nanoid; `libraryMeta` uses a fixed singleton id). */
  id: string;
}

/**
 * The singleton id for the per-user library-meta blob — there is exactly one
 * `libraryMeta` record per account, synced whole with LWW.
 */
export const LIBRARY_META_ID = 'library';

/**
 * Flat map key for one item, e.g. `track:V1StGXR8_Z5j`. Kinds contain no `:`,
 * so the first `:` always splits kind from id (ids keep any `:` they contain).
 */
export function itemKey(kind: SyncKind, id: string): string {
  return `${kind}:${id}`;
}

/** Inverse of {@link itemKey}. Total: malformed keys yield `undefined`. */
export function parseItemKey(key: string): ItemRef | undefined {
  const sep = key.indexOf(':');
  if (sep <= 0) return undefined;
  const kind = key.slice(0, sep);
  const id = key.slice(sep + 1);
  if (!isSyncKind(kind) || id === '') return undefined;
  return { kind, id };
}
