import type {
  Bundle,
  Folder,
  GeoReference,
  MapDocument,
  TrackSummary,
  Waypoint,
} from '@core/models';
import type { CustomCategory } from './categories';

/**
 * Versioned migrations for Inukshuk's persisted JSON documents (`library.json`
 * and `settings.json`). Every document written to disk carries a
 * `schemaVersion`; documents written before versioning existed (or by builds
 * that predate a field) are treated as **version 1** and normalized here.
 *
 * The migrators are *total*: any parseable JSON value in — a usable, fully
 * typed document out. Unknown fields are dropped, wrong-typed fields fall back
 * to defaults, and future/unknown versions are sanitized rather than rejected,
 * so a downgrade or a hand-edited file never crashes hydration.
 */

/** Current `library.json` schema. v1 = the unversioned legacy index. */
export const LIBRARY_SCHEMA_VERSION = 3;
/** Current `settings.json` schema. v1 = the unversioned legacy settings. */
export const SETTINGS_SCHEMA_VERSION = 2;

/** The persisted shape of `library.json` at {@link LIBRARY_SCHEMA_VERSION}. */
export interface LibraryIndex {
  schemaVersion: number;
  maps: MapDocument[];
  tracks: TrackSummary[];
  bundles: Bundle[];
  folders: Folder[];
  activeMapId: string | null;
  /** Ids of saved trails shown as overlays on the main map (persisted, like `activePages`). */
  activeTrackIds: string[];
  /** Standalone waypoints dropped on the map outside any recording. */
  waypoints: Waypoint[];
  /** User-defined activity categories (see `@core/library/categories`). */
  customCategories: CustomCategory[];
}

type RawDoc = Record<string, unknown>;

function isRecord(value: unknown): value is RawDoc {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): RawDoc {
  return isRecord(value) ? value : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function docVersion(doc: RawDoc): number {
  return typeof doc.schemaVersion === 'number' && Number.isFinite(doc.schemaVersion)
    ? doc.schemaVersion
    : 1;
}

/**
 * Run the stepwise vN→vN+1 ladder from the document's version up to `target`.
 * A gap in the ladder (unknown version) stops the walk; the caller's sanitize
 * pass still guarantees a usable shape.
 */
function runLadder(doc: RawDoc, upgraders: Record<number, (d: RawDoc) => RawDoc>, target: number) {
  let current = doc;
  for (let v = docVersion(doc); v < target; v++) {
    const upgrade = upgraders[v];
    if (!upgrade) break;
    current = upgrade(current);
  }
  return current;
}

// --- library.json -----------------------------------------------------------

/**
 * Normalize one persisted map document to the current shape. Older builds
 * stored a single `georeference` (or none); the current model stores
 * `georeferences[]` + `activePages[]` (defaulting to every georeferenced page
 * so overlays stay visible after an update). Idempotent, so it doubles as the
 * totality guard for maps in already-versioned indexes.
 */
function normalizeMapDoc(raw: RawDoc): MapDocument {
  const legacy = raw as Partial<MapDocument> & { georeference?: GeoReference | null };
  const georeferences = Array.isArray(legacy.georeferences)
    ? legacy.georeferences
    : legacy.georeference
      ? [legacy.georeference]
      : [];
  const activePages = Array.isArray(legacy.activePages)
    ? legacy.activePages
    : georeferences.map((g) => g.pageIndex);
  return {
    id: String(legacy.id ?? ''),
    name: String(legacy.name ?? ''),
    fileUri: String(legacy.fileUri ?? ''),
    importedAt: typeof legacy.importedAt === 'number' ? legacy.importedAt : 0,
    pageCount: typeof legacy.pageCount === 'number' ? legacy.pageCount : georeferences.length,
    georeferences,
    activePages,
    ...(typeof legacy.georeferenceWarning === 'string'
      ? { georeferenceWarning: legacy.georeferenceWarning }
      : {}),
    ...(typeof legacy.folderId === 'string' ? { folderId: legacy.folderId } : {}),
  };
}

const LIBRARY_UPGRADERS: Record<number, (doc: RawDoc) => RawDoc> = {
  // v1 (unversioned) → v2: trail-overlay activation moved into the persisted
  // index; older indexes never stored it, so it starts empty. (The per-map
  // `georeference` → `georeferences[]` normalization runs in the sanitize pass
  // below — it is idempotent and guards junk in any version.)
  1: (doc) => ({ ...doc, schemaVersion: 2, activeTrackIds: asArray(doc.activeTrackIds) }),
  // v2 → v3: standalone waypoints AND user-defined activity categories joined
  // the persisted index in the same release; older indexes never stored
  // either, so both lists start empty. (Tracks' optional `category` needs no
  // migration — absent simply means uncategorized.)
  2: (doc) => ({
    ...doc,
    schemaVersion: 3,
    waypoints: asArray(doc.waypoints),
    customCategories: asArray(doc.customCategories),
  }),
};

/** Keep only array entries that look like persisted records with a string id. */
function recordsWithId<T extends { id: string }>(value: unknown): T[] {
  return asArray(value).filter((x): x is T => isRecord(x) && typeof x.id === 'string');
}

/**
 * Migrate a raw parsed `library.json` (any version, or junk) to the current
 * {@link LibraryIndex}. Never throws; dangling `activeTrackIds` / `activeMapId`
 * references are pruned so deleted items can't leak back in as overlays.
 */
export function migrateLibraryIndex(raw: unknown): LibraryIndex {
  const doc = runLadder(asRecord(raw), LIBRARY_UPGRADERS, LIBRARY_SCHEMA_VERSION);
  const maps = asArray(doc.maps).filter(isRecord).map(normalizeMapDoc);
  const tracks = recordsWithId<TrackSummary>(doc.tracks);
  const activeMapId = typeof doc.activeMapId === 'string' ? doc.activeMapId : null;
  return {
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    maps,
    tracks,
    bundles: recordsWithId<Bundle>(doc.bundles),
    folders: recordsWithId<Folder>(doc.folders),
    activeMapId: maps.some((m) => m.id === activeMapId) ? activeMapId : null,
    activeTrackIds: asArray(doc.activeTrackIds).filter(
      (id): id is string => typeof id === 'string' && tracks.some((t) => t.id === id),
    ),
    // A waypoint without a finite coordinate can never be drawn or edited —
    // drop such junk rather than let it reach the map's marker projection.
    waypoints: recordsWithId<Waypoint>(doc.waypoints).filter(
      (w) => Number.isFinite(w.latitude) && Number.isFinite(w.longitude),
    ),
    // Keep only well-formed custom categories: junk entries would render as
    // broken chips, and a missing color would defeat the theme-safety gate.
    customCategories: recordsWithId<CustomCategory>(doc.customCategories).filter(
      (c) => typeof c.name === 'string' && c.name.trim() !== '' && typeof c.color === 'string',
    ),
  };
}

// --- settings.json -----------------------------------------------------------

const SETTINGS_UPGRADERS: Record<number, (doc: RawDoc) => RawDoc> = {
  // v1 (unversioned) → v2: no field changes — v2 only added the version
  // envelope. Future settings migrations slot in here.
  1: (doc) => ({ ...doc, schemaVersion: 2 }),
};

/**
 * Migrate a raw parsed `settings.json` (any version, or junk) onto `defaults`.
 * Only keys present in `defaults` are kept, and only when the persisted value
 * has the same primitive type as the default — junk fields are dropped and
 * wrong-typed values fall back to the default. Never throws.
 */
export function migrateSettings<S extends object>(raw: unknown, defaults: S): S {
  const doc = runLadder(asRecord(raw), SETTINGS_UPGRADERS, SETTINGS_SCHEMA_VERSION);
  const out: RawDoc = { ...(defaults as RawDoc) };
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = doc[key];
    if (value !== undefined && typeof value === typeof fallback) out[key] = value;
  }
  return out as S;
}
