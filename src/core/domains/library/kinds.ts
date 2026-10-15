import type { Json } from '@core/team/canonical';
import { isShortId } from '@core/team/ids';
import { BASE_FIELD, parseBase } from '@core/group/conflicts';
import { flag, knownFieldsValid, text, type FieldRule } from '@core/group/fields';

/**
 * The library domain's record kinds (2.7.0 #712, `docs/design/sync-layer.md`
 * §5.3; security review §4). Wire names are short: every op carries them.
 *
 * | kind | key | fields | who writes | who purges (`e.del`) |
 * |---|---|---|---|---|
 * | `lfo` folder | shared `(lfo, id)` | `n` name, `p` parent folder, `o` order, `rm` | editors+ | managers, from the trash |
 * | `lit` item | shared `(lit, id)` | `t` type (once), `n`, `p`, `o`, `d`, `sty`, `rm`; `g` track/area geometry; `ll` `el` `ic` waypoint; `cat` catalog map | editors+ | managers, from the trash |
 * | `lac` activity cursor | owned, id `g` | `seen` (ms) | anyone, their own | its member or a manager |
 * | `lcm` comment | owned | `on` record id (once), `tx` | anyone (viewers too), their own | its writer or a manager |
 *
 * Every `lfo`/`lit` write may carry a base `b` (`@core/group/conflicts`).
 * Deleting is a **soft delete**: `rm: 1` puts the record in the trash (its
 * fields stay, so Restore is `rm: 0` and keeps any edit made meanwhile);
 * a manager's `e.del` purges it for good.
 *
 * Fields are **forward-lenient** (`@core/group/fields`): known fields are
 * checked strictly, unknown ones (a 2.7.1 blob manifest `m`, say) are kept,
 * so a newer phone's item is never dropped by this one.
 */
export const LFO = 'lfo';
export const LIT = 'lit';
export const LAC = 'lac';
export const LCM = 'lcm';
export const LIBRARY_KINDS: readonly string[] = [LFO, LIT, LAC, LCM];
/** Kinds forming the shared tree (soft delete, base stamps, purge). */
export const TREE_KINDS: readonly string[] = [LFO, LIT];
/** Owned kinds: keyed `(kind, owner, id)`. */
export const OWNED_LIBRARY_KINDS: readonly string[] = [LAC, LCM];

/** The activity cursor's id (one per member). */
export const CURSOR_ID = 'g';

// ── Limits (security review §4.5) ───────────────────────────────────────────

export const MAX_ITEMS = 5000;
export const MAX_FOLDERS = 1000;
/** Folders nest at most this deep below the shared root. */
export const MAX_FOLDER_DEPTH = 8;
/**
 * A track or area geometry inline in the op (larger ones become blobs, 2.7.1).
 * Not the design's 24 KiB: an `e.set` is capped at 32 KiB *after* AEAD and
 * base64url, which leaves ~20 KiB of plaintext body (measured in
 * `replica.test.ts`); {@link MAX_INLINE_BODY} is the real gate.
 */
export const MAX_INLINE_GEOMETRY = 16 * 1024;
/** Plaintext JSON bytes of one library `e.set` body that always fit the encrypted op cap. */
export const MAX_INLINE_BODY = 20_000;
export const MAX_NAME = 120;
export const MAX_DESCRIPTION = 4000;
export const MAX_COMMENT = 1000;
/** Trash entries stay restorable on every phone this long (R-LIB-1). */
export const TRASH_MS = 30 * 24 * 60 * 60 * 1000;

// ── Field rules ─────────────────────────────────────────────────────────────

export const ITEM_TYPES = ['trk', 'wpt', 'map', 'area'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

const finite = (v: Json): v is number => typeof v === 'number' && Number.isFinite(v);

const id: FieldRule = (v) => isShortId(v);
const order: FieldRule = finite;
const description: FieldRule = (v) => typeof v === 'string' && v.length <= MAX_DESCRIPTION;
/** Google encoded polyline (`@core/trails/polyline`): printable ASCII 63–126 only. */
const geometry: FieldRule = (v) =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_INLINE_GEOMETRY && /^[?-~]+$/.test(v);
const lngLat: FieldRule = (v) => {
  if (!Array.isArray(v) || v.length !== 2) return false;
  const [lng, lat] = v as [Json, Json];
  return finite(lng) && finite(lat) && Math.abs(lng) <= 180 && Math.abs(lat) <= 90;
};
const elevation: FieldRule = (v) => finite(v) && Math.abs(v) <= 20_000;
/** An icon id (a newer build's ids included: kept, drawn as the default pin until known). */
const icon: FieldRule = (v) => typeof v === 'string' && /^[a-z0-9_-]{1,64}$/.test(v);
/** A catalog id (`cpa-…`, `qcriv-…`): each phone resolves it in its OWN catalog, never a URL. */
export const isCatalogId = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const STYLE_KEYS: Readonly<Record<string, FieldRule>> = {
  /** Colour `#RRGGBB`. */
  c: (v) => typeof v === 'string' && /^#[0-9A-Fa-f]{6}$/.test(v),
  /** Pin size. */
  s: (v) => v === 'S' || v === 'M' || v === 'L' || v === 'XL',
  /** Line width (px). */
  w: (v) => finite(v) && v > 0 && v <= 64,
};
const style: FieldRule = (v) =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).length <= 16 &&
  knownFieldsValid(v as Record<string, Json>, STYLE_KEYS);
const base: FieldRule = (v) => parseBase(v) !== undefined;

const TREE_COMMON: Readonly<Record<string, FieldRule>> = {
  n: text(MAX_NAME),
  p: id,
  o: order,
  rm: flag,
  [BASE_FIELD]: base,
};

export const FOLDER_RULES: Readonly<Record<string, FieldRule>> = TREE_COMMON;

export const ITEM_RULES: Readonly<Record<string, FieldRule>> = {
  ...TREE_COMMON,
  t: (v) => (ITEM_TYPES as readonly Json[]).includes(v),
  d: description,
  sty: style,
  g: geometry,
  ll: lngLat,
  el: elevation,
  ic: icon,
  cat: isCatalogId,
};

export const CURSOR_RULES: Readonly<Record<string, FieldRule>> = {
  seen: (v) => Number.isSafeInteger(v) && (v as number) >= 0,
};

export const COMMENT_RULES: Readonly<Record<string, FieldRule>> = {
  on: id,
  tx: text(MAX_COMMENT),
};

/** Per kind: field rules, the fields a record's first write must carry, and write-once fields. */
export interface KindSpec {
  rules: Readonly<Record<string, FieldRule>>;
  first: readonly string[];
  once: readonly string[];
}

export const SPECS: ReadonlyMap<string, KindSpec> = new Map<string, KindSpec>([
  [LFO, { rules: FOLDER_RULES, first: ['n'], once: [] }],
  [LIT, { rules: ITEM_RULES, first: ['t', 'n'], once: ['t'] }],
  [LAC, { rules: CURSOR_RULES, first: ['seen'], once: [] }],
  [LCM, { rules: COMMENT_RULES, first: ['on', 'tx'], once: ['on'] }],
]);

export const isLibraryKind = (kind: string): boolean => SPECS.has(kind);
export const isTreeKind = (kind: string): boolean => TREE_KINDS.includes(kind);
export const isOwnedLibraryKind = (kind: string): boolean => OWNED_LIBRARY_KINDS.includes(kind);
