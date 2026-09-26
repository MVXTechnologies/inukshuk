import type {
  Folder,
  GeoReference,
  MapDocument,
  TrackSummary,
  TrackNote,
  Waypoint,
} from '@core/models';
import { toDocumentRelativePath } from '@core/storage/documentPaths';
import type { CustomCategory } from './categories';
import { isWaypointIcon } from './waypointIcons';

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
export const LIBRARY_SCHEMA_VERSION = 9;

/** How the map picks visible overlays: by item type toggles, or by folder. */
export type MapVisibilityMode = 'type' | 'folders';
/** Current `settings.json` schema. v1 = the unversioned legacy settings. */
export const SETTINGS_SCHEMA_VERSION = 2;

/** The persisted shape of `library.json` at {@link LIBRARY_SCHEMA_VERSION}. */
export interface LibraryIndex {
  schemaVersion: number;
  maps: MapDocument[];
  tracks: TrackSummary[];
  folders: Folder[];
  /** Map-visibility mode; folder selection applies only in 'folders' mode. */
  mapVisibilityMode: MapVisibilityMode;
  /** Folder ids (plus the 'ungrouped' pseudo-id) shown in 'folders' mode. */
  visibleFolderIds: string[];
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
 * Active page indices as a sorted, duplicate-free list of non-negative
 * integers. Junk entries (strings, NaN, negatives) are dropped rather than
 * carried into the overlay pipeline, which indexes PDF pages with them.
 */
function dedupePageIndices(value: readonly unknown[]): number[] {
  const pages = new Set<number>();
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0) continue;
    pages.add(entry);
  }
  return [...pages].sort((a, b) => a - b);
}

function hasFilePath(raw: RawDoc): boolean {
  return (
    typeof raw.id === 'string' &&
    raw.id !== '' &&
    typeof raw.fileUri === 'string' &&
    raw.fileUri.trim() !== ''
  );
}

function finiteFields(raw: unknown, fields: readonly string[]): boolean {
  return (
    isRecord(raw) &&
    fields.every((key) => typeof raw[key] === 'number' && Number.isFinite(raw[key]))
  );
}

/** Reject incomplete geometry before consumers dereference viewport corners. */
function isGeoReference(raw: unknown): raw is GeoReference {
  if (
    !isRecord(raw) ||
    !Number.isInteger(raw.pageIndex) ||
    Number(raw.pageIndex) < 0 ||
    !finiteFields(raw, ['pageWidthPt', 'pageHeightPt']) ||
    !isRecord(raw.viewport)
  )
    return false;
  const corners = raw.viewport.corners;
  return (
    finiteFields(raw.viewport.rect, ['x0', 'y0', 'x1', 'y1']) &&
    finiteFields(raw.bbox, ['minLat', 'maxLat', 'minLng', 'maxLng']) &&
    isRecord(corners) &&
    ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'].every((key) => {
      const point = corners[key];
      return (
        Array.isArray(point) &&
        point.length === 2 &&
        point.every((value) => typeof value === 'number' && Number.isFinite(value))
      );
    })
  );
}

/**
 * Keep a georeference's optional rendered page box only when it is a real
 * rectangle; a junk box is dropped so the page falls back to the pre-#287
 * placement (and is flagged for re-import) instead of dividing by zero.
 */
function normalizePageBox(geo: GeoReference): GeoReference {
  const { pageBox, ...rest } = geo;
  if (
    pageBox !== undefined &&
    finiteFields(pageBox, ['x0', 'y0', 'x1', 'y1']) &&
    pageBox.x1 > pageBox.x0 &&
    pageBox.y1 > pageBox.y0
  )
    return geo;
  return rest;
}

/** Invalid optional photos must not reach the document-path mapper. */
function normalizePhoto<T extends { photoUri?: unknown }>(raw: T) {
  const { photoUri, ...rest } = raw;
  return { ...rest, ...(typeof photoUri === 'string' && photoUri !== '' ? { photoUri } : {}) };
}

/**
 * Normalize one persisted waypoint's optional nested fields (#350): a junk or
 * unknown `icon` is DROPPED rather than carried, so the pin falls back to the
 * default instead of asking the renderer for a glyph that does not exist. That
 * also covers the downgrade case — an index written by a build whose catalogue
 * has icons this one lacks loads fine, it just draws default pins.
 */
function normalizeWaypoint(raw: Waypoint): Waypoint {
  const { icon, ...rest } = normalizePhoto(raw);
  return { ...rest, ...(isWaypointIcon(icon) ? { icon } : {}) };
}

function normalizeNotes(raw: unknown): TrackNote[] {
  return asArray(raw)
    .filter(isRecord)
    .filter((note) => typeof note.id === 'string')
    .map((note) => ({
      id: String(note.id),
      distanceM:
        typeof note.distanceM === 'number' && Number.isFinite(note.distanceM) ? note.distanceM : 0,
      text: typeof note.text === 'string' ? note.text : '',
      createdAt:
        typeof note.createdAt === 'number' && Number.isFinite(note.createdAt) ? note.createdAt : 0,
      ...(typeof note.photoUri === 'string' && note.photoUri !== ''
        ? { photoUri: note.photoUri }
        : {}),
    }));
}

/**
 * Normalize one persisted map document to the current shape. Older builds
 * stored a single `georeference` (or none); the current model stores
 * `georeferences[]` + `activePages[]` (defaulting to every georeferenced page
 * so overlays stay visible after an update). Idempotent, so it doubles as the
 * totality guard for maps in already-versioned indexes.
 */
function normalizeMapDoc(raw: RawDoc): MapDocument {
  const legacy = raw as Partial<MapDocument> & { georeference?: GeoReference | null };
  const georeferences = (Array.isArray(raw.georeferences) ? raw.georeferences : [raw.georeference])
    .filter(isGeoReference)
    .map(normalizePageBox);
  // Page indices are a SET: one entry per page, never one per viewport.
  // Builds before the primary-viewport fix wrote `georeferences.map(pageIndex)`
  // straight through, so a three-viewport sheet (US Topo, AUSTopo) persisted
  // [0, 0, 0] — which the overlay pipeline drew as three stacked copies of the
  // same raster and the Library counted as "3/1 shown". Normalizing here heals
  // those documents on the next hydration instead of waiting for the user to
  // toggle the page off and on again.
  const activePages = dedupePageIndices(
    Array.isArray(legacy.activePages) ? legacy.activePages : georeferences.map((g) => g.pageIndex),
  );
  const pageCount = typeof legacy.pageCount === 'number' ? legacy.pageCount : georeferences.length;
  const recoveryErrors: NonNullable<MapDocument['renderRecoveryErrors']> = [];
  for (const entry of asArray(raw.renderRecoveryErrors).filter(isRecord)) {
    const pageIndex = entry.pageIndex;
    if (
      typeof pageIndex !== 'number' ||
      !Number.isSafeInteger(pageIndex) ||
      pageIndex < 0 ||
      pageIndex >= pageCount ||
      recoveryErrors.some((error) => error.pageIndex === pageIndex)
    )
      continue;
    if (entry.reason === 'interrupted') recoveryErrors.push({ pageIndex, reason: 'interrupted' });
    else if (entry.reason === 'render-failed' && typeof entry.message === 'string') {
      recoveryErrors.push({
        pageIndex,
        reason: 'render-failed',
        message: entry.message.slice(0, 400),
      });
    }
  }
  recoveryErrors.sort((a, b) => a.pageIndex - b.pageIndex);
  return {
    id: String(legacy.id ?? ''),
    name: String(legacy.name ?? ''),
    fileUri: String(legacy.fileUri ?? ''),
    importedAt: typeof legacy.importedAt === 'number' ? legacy.importedAt : 0,
    pageCount,
    georeferences,
    activePages: activePages.filter(
      (page) => !recoveryErrors.some((error) => error.pageIndex === page),
    ),
    ...(recoveryErrors.length ? { renderRecoveryErrors: recoveryErrors } : {}),
    ...(typeof legacy.georeferenceWarning === 'string'
      ? { georeferenceWarning: legacy.georeferenceWarning }
      : {}),
    ...(typeof legacy.folderId === 'string' ? { folderId: legacy.folderId } : {}),
    ...(typeof legacy.sourceItemId === 'string' ? { sourceItemId: legacy.sourceItemId } : {}),
    ...(typeof legacy.sourceUpdatedAt === 'string'
      ? { sourceUpdatedAt: legacy.sourceUpdatedAt }
      : {}),
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
  // v3 → v4: bundles removed (folders absorbed their "show this set" job via
  // the new folder-visibility fields). Persisted bundles are dropped outright
  // — the user's call; items always kept their own folderId.
  3: (doc) => {
    const { bundles: _dropped, ...rest } = doc;
    return { ...rest, schemaVersion: 4, mapVisibilityMode: 'type', visibleFolderIds: [] };
  },
  // v4 → v5: maps gained optional catalog-provenance fields (`sourceItemId`,
  // `sourceUpdatedAt` — the map store's dedup/update keys). Absent on every
  // pre-v5 map by definition (the store didn't exist), so this is a pure
  // version-stamp bump; the fields ride through normalizeMapDoc when present.
  4: (doc) => ({ ...doc, schemaVersion: 5 }),
  // v5 → v6: stored file paths (`fileUri`, `photoUri`) became **document
  // relative** — `tracks/<id>.gpx` instead of an absolute
  // `file:///…/Application/<UUID>/Documents/tracks/<id>.gpx` (#247). iOS
  // rotates that UUID on every app update, so absolute paths went stale and
  // every trail, map and photo looked lost. A pure version stamp here: the
  // rewrite itself runs in the sanitize pass below, which is idempotent and so
  // also heals a v6 index written with a stray absolute path.
  5: (doc) => ({ ...doc, schemaVersion: 6 }),
  // v6 → v7: interrupted-page notices persist with their disabled page selection.
  6: (doc) => ({ ...doc, schemaVersion: 7 }),
  // v7 → v8: georeferences gained the optional rendered page box (`pageBox`,
  // CropBox ∩ MediaBox with its origin — #287). Deliberately NOT synthesized
  // here: a pre-v8 georeference has no way of knowing whether its page was
  // cropped, and an invented `[0, 0, w, h]` would look authoritative. Absent
  // means "placed the old way; re-import to reprocess" (see
  // `needsPageBoxReprocessing`), and the sanitize pass validates the field
  // wherever it is present.
  7: (doc) => ({ ...doc, schemaVersion: 8 }),
  // v8 → v9: waypoints gained the optional pin `icon` (#350). Absent means the
  // default inukshuk pin — exactly what every pre-v9 waypoint drew — so there
  // is nothing to synthesize and nothing to lose; a pure version stamp. The
  // sanitize pass below validates the field wherever it IS present.
  8: (doc) => ({ ...doc, schemaVersion: 9 }),
};

/** Keep only array entries that look like persisted records with a string id. */
function recordsWithId<T extends { id: string }>(value: unknown): T[] {
  return asArray(value).filter((x): x is T => isRecord(x) && typeof x.id === 'string');
}

/**
 * Apply `map` to every stored file path in an index — the maps' `fileUri`, the
 * trails' `fileUri`, their notes' `photoUri`, and standalone waypoints'
 * `photoUri`. **This is the complete list of persisted paths in
 * `library.json`**; anything new that stores a path must be added here, or it
 * will go stale on the next iOS container rotation (#247).
 *
 * Used in both directions: relativised on the way to disk, resolved against
 * the current document directory on the way back.
 */
export function mapLibraryIndexPaths(
  index: LibraryIndex,
  map: (path: string) => string,
): LibraryIndex {
  return {
    ...index,
    maps: index.maps.map((m) => ({ ...m, fileUri: map(m.fileUri) })),
    tracks: index.tracks.map((t) => ({
      ...t,
      fileUri: map(t.fileUri),
      ...(t.notes
        ? {
            notes: t.notes.map((n) =>
              n.photoUri === undefined ? n : { ...n, photoUri: map(n.photoUri) },
            ),
          }
        : {}),
    })),
    waypoints: index.waypoints.map((w) =>
      w.photoUri === undefined ? w : { ...w, photoUri: map(w.photoUri) },
    ),
  };
}

/**
 * Migrate a raw parsed `library.json` (any version, or junk) to the current
 * {@link LibraryIndex}. Never throws; dangling `activeTrackIds` / `activeMapId`
 * references are pruned so deleted items can't leak back in as overlays.
 *
 * `documentDir` (the app document directory as a `file://` uri) lets the path
 * pass strip the *current* container's prefix as well as a rotated one; it is
 * optional so the migration stays pure and callable from tests. Paths that are
 * absolute but under no document directory are left exactly as they are —
 * they are not ours to rewrite (the caller logs them).
 */
export function migrateLibraryIndex(raw: unknown, documentDir?: string): LibraryIndex {
  const doc = runLadder(asRecord(raw), LIBRARY_UPGRADERS, LIBRARY_SCHEMA_VERSION);
  const maps = asArray(doc.maps).filter(isRecord).filter(hasFilePath).map(normalizeMapDoc);
  const tracks = recordsWithId<TrackSummary>(doc.tracks)
    .filter((track) => typeof track.fileUri === 'string' && track.fileUri.trim() !== '')
    .map((track) => ({
      ...track,
      ...(track.notes !== undefined ? { notes: normalizeNotes(track.notes) } : {}),
    }));
  const activeMapId = typeof doc.activeMapId === 'string' ? doc.activeMapId : null;
  const index: LibraryIndex = {
    schemaVersion: LIBRARY_SCHEMA_VERSION,
    maps,
    tracks,
    folders: recordsWithId<Folder>(doc.folders),
    mapVisibilityMode: doc.mapVisibilityMode === 'folders' ? 'folders' : 'type',
    visibleFolderIds: asArray(doc.visibleFolderIds).filter(
      (id): id is string => typeof id === 'string',
    ),
    activeMapId: maps.some((m) => m.id === activeMapId) ? activeMapId : null,
    activeTrackIds: asArray(doc.activeTrackIds).filter(
      (id): id is string => typeof id === 'string' && tracks.some((t) => t.id === id),
    ),
    // A waypoint without a finite coordinate can never be drawn or edited —
    // drop such junk rather than let it reach the map's marker projection.
    waypoints: recordsWithId<Waypoint>(doc.waypoints)
      .filter((w) => Number.isFinite(w.latitude) && Number.isFinite(w.longitude))
      .map(normalizeWaypoint),
    // Keep only well-formed custom categories: junk entries would render as
    // broken chips, and a missing color would defeat the theme-safety gate.
    customCategories: recordsWithId<CustomCategory>(doc.customCategories).filter(
      (c) => typeof c.name === 'string' && c.name.trim() !== '' && typeof c.color === 'string',
    ),
  };
  // #247 — runs on EVERY load, not just the v5→v6 step: the population that
  // needs healing is already at v5/v6 with absolute paths burned in, and the
  // rewrite is idempotent so a second pass costs nothing.
  return mapLibraryIndexPaths(index, (path) => toDocumentRelativePath(path, documentDir));
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
