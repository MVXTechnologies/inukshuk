import { latToMercY, lonToMercX, type GeoBbox } from './marineDepth';
import {
  bestPackableSource,
  marineSourceById,
  type MarineSource,
  type MarineSourceId,
} from './marineSources';

/**
 * Offline marine packs (marine wave D §D4) — pure geometry, bookkeeping and
 * the banner's trigger rule. A "pack" is a fixed 0.1° grid cell of raw depth
 * data stored as the source's own float32 GeoTIFF: ONE file per cell that
 * the existing `@core/geo/depthChart` renderer draws AND that tap-for-depth
 * samples directly, so a downloaded reach works completely offline without a
 * tile pyramid.
 *
 * Sizes are computed exactly from grid geometry, not guessed from a
 * bytes/km² constant — a float32 grid's size is fully determined by the
 * subset extent and the source's native cell. Verified against a live NONNA
 * fetch 2026-08-10: a 0.1°×0.1° cell over the Québec City ship channel
 * (−71.30/46.75 → −71.20/46.85) came back as a 583×850 float32 GeoTIFF, and
 * a tile-aligned request measured **1 954 210 B** on the wire — this module's
 * estimator predicts 1 984 532 B for the same cell (1.5 % over). That works
 * out to ~23 KB/km² at 46.8°N: **~2 MB per 0.1° cell**, ~8 MB for the
 * four-cell viewport the banner typically offers, and ~14 MB for the design
 * package's 40 × 15 km Québec City–Île d'Orléans reach — its quoted figure.
 * (Its 45.6 KB/km² came off an untuned request whose tile padding wasted 4×;
 * `scalesize`-aligning the subset removes that, verified live.)
 *
 * Everything here is pure; `@data/marinePacks` owns the files and
 * `@state/marinePackStore` owns the download/update lifecycle.
 */

/** Pack granularity: one stored grid per 0.1° cell. */
export const MARINE_PACK_CELL_DEG = 0.1;

/**
 * Hard cap on cells offered at once. 12 cells ≈ 47 MB at NONNA resolution —
 * a big but honest one-tap download; a wider viewport simply gets no offer
 * (the banner is for a boating reach, not a province).
 */
export const MARINE_PACK_MAX_CELLS = 12;

/**
 * Sanity ceiling on the viewport the banner will offer for (degrees, either
 * axis). Owner report 2026-08-10 ("I was in the Québec region and it didn't
 * ask me for marine charts"): the old 0.6° cap made the offer unreachable at
 * ordinary boating zooms — a 390×844 pt phone at z10 already spans ~0.40° of
 * latitude and z9 spans ~0.79°, so the trigger silently returned null exactly
 * where a boater looks at a reach. The DOWNLOAD size is capped by
 * {@link MARINE_PACK_MAX_CELLS} instead (a wider view gets the centred block
 * that fits), which is the thing that actually needs bounding; this ceiling
 * only keeps the offer off a continent-wide view — it matches
 * `DEPTH_MAX_VIEW_SPAN_DEG`, past which no chart renders at all.
 */
export const MARINE_PACK_MAX_VIEW_SPAN_DEG = 6;

/** Packs older than this are refreshed by the auto-update sweep. */
export const MARINE_PACK_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** How long "Not now" silences the offer for a region. */
export const MARINE_PACK_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

/** A single stored pack cell. */
export interface MarinePackCell {
  /** Stable storage key, `<sourceId>:<latIdx>:<lonIdx>`. */
  key: string;
  sourceId: MarineSourceId;
  latIdx: number;
  lonIdx: number;
  bbox: GeoBbox;
}

/** A pack cell as recorded on disk. */
export interface MarinePackRecord {
  key: string;
  sourceId: MarineSourceId;
  bbox: GeoBbox;
  bytes: number;
  /** Epoch ms of the last successful fetch. */
  updatedAt: number;
}

const EPS = 1e-9;

/** Floor a coordinate onto the 0.1° pack grid (index, not degrees). */
export function packCellIndex(deg: number): number {
  return Math.floor(deg / MARINE_PACK_CELL_DEG + EPS);
}

export function packCellKey(sourceId: MarineSourceId, latIdx: number, lonIdx: number): string {
  return `${sourceId}:${latIdx}:${lonIdx}`;
}

/** Parse a storage key back into its parts, or null on junk. */
export function parsePackCellKey(key: string): MarinePackCell | null {
  const parts = key.split(':');
  if (parts.length !== 3) return null;
  const [sourceId, latRaw, lonRaw] = parts;
  if (sourceId === undefined || latRaw === undefined || lonRaw === undefined) return null;
  const latIdx = Number.parseInt(latRaw, 10);
  const lonIdx = Number.parseInt(lonRaw, 10);
  if (!Number.isInteger(latIdx) || !Number.isInteger(lonIdx)) return null;
  const source = marineSourceById(sourceId as MarineSourceId);
  if (source.id !== sourceId) return null;
  return { key, sourceId: source.id, latIdx, lonIdx, bbox: packCellBbox(latIdx, lonIdx) };
}

/** The geographic box of a pack cell. */
export function packCellBbox(latIdx: number, lonIdx: number): GeoBbox {
  const round = (v: number): number => Math.round(v * 1e6) / 1e6;
  return {
    west: round(lonIdx * MARINE_PACK_CELL_DEG),
    south: round(latIdx * MARINE_PACK_CELL_DEG),
    east: round((lonIdx + 1) * MARINE_PACK_CELL_DEG),
    north: round((latIdx + 1) * MARINE_PACK_CELL_DEG),
  };
}

/**
 * The largest `columns × rows` block that fits in `maxCells` while staying
 * inside `nx × ny` and tracking the viewport's aspect ratio as closely as it
 * can. Pure integer search over the (few) candidate row counts.
 */
function fitBlock(nx: number, ny: number, maxCells: number): { kx: number; ky: number } {
  if (nx * ny <= maxCells) return { kx: nx, ky: ny };
  const aspect = nx / ny;
  let best = { kx: 1, ky: 1 };
  let bestScore = -Infinity;
  for (let ky = 1; ky <= ny; ky++) {
    const kx = Math.min(nx, Math.floor(maxCells / ky));
    if (kx < 1) break;
    // Prefer the biggest download that still fits, then the closest aspect.
    const score = kx * ky * 1000 - Math.abs(kx / ky - aspect);
    if (score > bestScore) {
      bestScore = score;
      best = { kx, ky };
    }
  }
  return best;
}

/**
 * The pack cells a viewport needs, row-major from the south-west corner.
 *
 * When the viewport spans more cells than `maxCells` the list is CENTRED and
 * clamped to the biggest block that fits rather than emptied (owner report
 * 2026-08-10: an ordinary boating zoom over Québec offered nothing at all).
 * The caller is told the offer is partial so the prompt can say so — the old
 * behaviour silently refused, which read as "no packs here".
 *
 * Still empty for a degenerate or antimeridian-crossing viewport.
 */
export function marinePackCellsForView(
  sourceId: MarineSourceId,
  view: GeoBbox,
  maxCells: number = MARINE_PACK_MAX_CELLS,
): MarinePackCell[] {
  if (!(view.east > view.west) || !(view.north > view.south)) return [];
  if (view.west < -180 || view.east > 180) return [];
  if (maxCells < 1) return [];
  const lon0 = packCellIndex(view.west);
  const lon1 = packCellIndex(view.east - EPS);
  const lat0 = packCellIndex(view.south);
  const lat1 = packCellIndex(view.north - EPS);
  const nx = lon1 - lon0 + 1;
  const ny = lat1 - lat0 + 1;
  if (nx < 1 || ny < 1) return [];
  const { kx, ky } = fitBlock(nx, ny, maxCells);
  // Centre the (possibly clamped) block on the viewport centre.
  const cx = packCellIndex((view.west + view.east) / 2);
  const cy = packCellIndex((view.south + view.north) / 2);
  const startX = Math.max(lon0, Math.min(lon1 - kx + 1, cx - Math.floor((kx - 1) / 2)));
  const startY = Math.max(lat0, Math.min(lat1 - ky + 1, cy - Math.floor((ky - 1) / 2)));
  const cells: MarinePackCell[] = [];
  for (let latIdx = startY; latIdx < startY + ky; latIdx++) {
    for (let lonIdx = startX; lonIdx < startX + kx; lonIdx++) {
      cells.push({
        key: packCellKey(sourceId, latIdx, lonIdx),
        sourceId,
        latIdx,
        lonIdx,
        bbox: packCellBbox(latIdx, lonIdx),
      });
    }
  }
  return cells;
}

/** Does a viewport need more cells than `maxCells` (so the offer is partial)? */
export function marinePackViewIsPartial(
  view: GeoBbox,
  maxCells: number = MARINE_PACK_MAX_CELLS,
): boolean {
  if (!(view.east > view.west) || !(view.north > view.south)) return false;
  const nx = packCellIndex(view.east - EPS) - packCellIndex(view.west) + 1;
  const ny = packCellIndex(view.north - EPS) - packCellIndex(view.south) + 1;
  return nx * ny > maxCells;
}

/**
 * Grid dimensions a pack cell will be fetched at: the source's native cell
 * count over the cell's extent, capped at `maxPackDim` per axis. Mercator
 * sources measure in mercator metres (so a cell is taller in pixels than it
 * is wide the further north it sits), the EPSG:4326 sources in degrees.
 */
export function packCellGridDims(
  source: MarineSource,
  bbox: GeoBbox,
): { width: number; height: number } {
  const grid = source.grid;
  if (grid === null) return { width: 0, height: 0 };
  const spanX =
    grid.crs === 'EPSG:3857'
      ? lonToMercX(bbox.east) - lonToMercX(bbox.west)
      : bbox.east - bbox.west;
  const spanY =
    grid.crs === 'EPSG:3857'
      ? latToMercY(bbox.north) - latToMercY(bbox.south)
      : bbox.north - bbox.south;
  const nativeW = Math.max(1, Math.round(spanX / grid.nativeCell));
  const nativeH = Math.max(1, Math.round(spanY / grid.nativeCell));
  const scale = Math.min(1, grid.maxPackDim / Math.max(nativeW, nativeH));
  return {
    width: Math.max(1, Math.round(nativeW * scale)),
    height: Math.max(1, Math.round(nativeH * scale)),
  };
}

/** Exact wire size of one pack cell: width × height × 4 bytes + TIFF header. */
export function estimatePackCellBytes(source: MarineSource, bbox: GeoBbox): number {
  const { width, height } = packCellGridDims(source, bbox);
  if (width === 0 || height === 0) return 0;
  return width * height * 4 + TIFF_OVERHEAD_BYTES;
}

/** Header + IFD of a GeoServer/ArcGIS float32 GeoTIFF (measured: ~450 B). */
const TIFF_OVERHEAD_BYTES = 512;

/** Total estimated download for a set of cells. */
export function estimatePackBytes(source: MarineSource, cells: readonly MarinePackCell[]): number {
  return cells.reduce((sum, cell) => sum + estimatePackCellBytes(source, cell.bbox), 0);
}

/** Is every cell a viewport needs already stored? */
export function packsCoverView(
  sourceId: MarineSourceId,
  view: GeoBbox,
  installed: ReadonlySet<string>,
  maxCells: number = MARINE_PACK_MAX_CELLS,
): boolean {
  const cells = marinePackCellsForView(sourceId, view, maxCells);
  return cells.length > 0 && cells.every((cell) => installed.has(cell.key));
}

/** The stored cell containing a point, or null. */
export function packCellAt(
  sourceId: MarineSourceId,
  lat: number,
  lon: number,
  installed: ReadonlySet<string>,
): string | null {
  const key = packCellKey(sourceId, packCellIndex(lat), packCellIndex(lon));
  return installed.has(key) ? key : null;
}

/** Packs due for a silent refresh (older than the max age). */
export function stalePackKeys(
  records: readonly MarinePackRecord[],
  now: number,
  maxAgeMs: number = MARINE_PACK_MAX_AGE_MS,
): string[] {
  return records.filter((r) => now - r.updatedAt >= maxAgeMs).map((r) => r.key);
}

/**
 * Short human label for a pack cell — its south-west corner in whole tenths
 * of a degree, e.g. "46.8°N 71.3°W". Enough to recognise a reach in the
 * Settings list without geocoding anything.
 */
export function packCellLabel(bbox: GeoBbox): string {
  const lat = `${Math.abs(bbox.south).toFixed(1)}°${bbox.south < 0 ? 'S' : 'N'}`;
  const lon = `${Math.abs(bbox.west).toFixed(1)}°${bbox.west < 0 ? 'W' : 'E'}`;
  return `${lat} ${lon}`;
}

// --- Snooze bookkeeping -----------------------------------------------------
// Persisted as plain `"<regionKey>@<expiryEpochMs>"` strings so the settings
// store's array + sanitizer idiom (see `sanitizeMarineLayers`) applies as-is.

/** The snooze key for an offer — the offer's south-west pack cell. */
export function packOfferRegionKey(cells: readonly MarinePackCell[]): string {
  const first = cells[0];
  return first === undefined ? '' : first.key;
}

export function encodePackSnooze(regionKey: string, expiresAt: number): string {
  return `${regionKey}@${Math.round(expiresAt)}`;
}

export function decodePackSnooze(entry: string): { regionKey: string; expiresAt: number } | null {
  const at = entry.lastIndexOf('@');
  if (at <= 0) return null;
  const regionKey = entry.slice(0, at);
  const expiresAt = Number.parseInt(entry.slice(at + 1), 10);
  if (!Number.isFinite(expiresAt)) return null;
  return { regionKey, expiresAt };
}

/** Drop junk and expired entries (settings hydration + write-back). */
export function sanitizeMarinePackSnoozes(v: unknown, now: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const entry of v) {
    if (typeof entry !== 'string') continue;
    const decoded = decodePackSnooze(entry);
    if (decoded === null || decoded.expiresAt <= now) continue;
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/**
 * The region keys currently silenced, as a set. Deliberately CLOCK-FREE so
 * the banner's trigger can run during render: expiry is applied once at
 * settings hydration (`sanitizeMarinePackSnoozes`) and again whenever an
 * entry is added, which is all a 30-day snooze needs — the worst case is a
 * lapsed snooze staying quiet until the next app launch.
 */
export function snoozedPackRegions(snoozes: readonly string[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const entry of snoozes) {
    const decoded = decodePackSnooze(entry);
    if (decoded !== null) out.add(decoded.regionKey);
  }
  return out;
}

export function isPackOfferSnoozed(
  regionKey: string,
  snoozes: readonly string[],
  now: number,
): boolean {
  return snoozes.some((entry) => {
    const decoded = decodePackSnooze(entry);
    return decoded !== null && decoded.regionKey === regionKey && decoded.expiresAt > now;
  });
}

// --- The banner's trigger rule ---------------------------------------------

/**
 * Why the banner is offering a pack. The copy differs per reason so the
 * prompt never over-claims:
 *
 * - `coarse` — a far better survey exists here than what is on screen (the
 *   ladder fell through to GEBCO/EMODnet where NONNA or NCEI has real data);
 * - `unavailable` — nothing rendered at all (host down, or offline-only);
 * - `offline` — the best source IS on screen, but only while online.
 */
export type MarinePackOfferReason = 'coarse' | 'unavailable' | 'offline';

export interface MarinePackOffer {
  source: MarineSource;
  cells: MarinePackCell[];
  bytes: number;
  reason: MarinePackOfferReason;
  /** Snooze key for "Not now". */
  regionKey: string;
  /**
   * True when the viewport needs more cells than the download cap allows, so
   * the offer covers the CENTRE of the view rather than all of it. The banner
   * says so — a pack that quietly stopped halfway would read as "no data".
   */
  partial: boolean;
}

export interface MarinePackOfferInput {
  /** Marine chart mode on, 2D, not in a region-select flow. */
  active: boolean;
  /** The settled viewport, or null while unknown. */
  view: GeoBbox | null;
  /** The source that actually rendered, or null when nothing did. */
  activeSourceId: MarineSourceId | null;
  /** Keys of the cells already on disk. */
  installed: ReadonlySet<string>;
  /** Region keys the user waved off — see {@link snoozedPackRegions}. */
  snoozedRegions: ReadonlySet<string>;
}

/**
 * Should the low-resolution banner appear, and for what? Pure, so the whole
 * decision is unit-tested rather than guessed at on a boat.
 *
 * A pack is only ever offered when it would genuinely beat what the user is
 * looking at, and never twice for a region the user waved off. Ordering
 * matters: the cheap disqualifiers run first so the common case (chart mode
 * off, or a pack already covering the view) costs nothing.
 */
export function marinePackOffer(input: MarinePackOfferInput): MarinePackOffer | null {
  const { active, view, activeSourceId, installed, snoozedRegions } = input;
  if (!active || view === null) return null;
  const lonSpan = view.east - view.west;
  const latSpan = view.north - view.south;
  if (!(lonSpan > 0) || !(latSpan > 0)) return null;
  if (lonSpan > MARINE_PACK_MAX_VIEW_SPAN_DEG || latSpan > MARINE_PACK_MAX_VIEW_SPAN_DEG) {
    return null;
  }
  const source = bestPackableSource(view);
  if (source === null) return null;
  const cells = marinePackCellsForView(source.id, view);
  if (cells.length === 0) return null;
  if (cells.every((cell) => installed.has(cell.key))) return null;
  const regionKey = packOfferRegionKey(cells);
  if (snoozedRegions.has(regionKey)) return null;

  const reason: MarinePackOfferReason =
    activeSourceId === null
      ? 'unavailable'
      : marineSourceById(activeSourceId).cellSizeM > source.cellSizeM * 1.5
        ? 'coarse'
        : 'offline';

  return {
    source,
    cells,
    bytes: estimatePackBytes(source, cells),
    reason,
    regionKey,
    partial: marinePackViewIsPartial(view),
  };
}

/** The banner's headline for an offer — plain, quiet, never alarmist. */
export function marinePackOfferMessage(offer: MarinePackOffer): string {
  switch (offer.reason) {
    case 'coarse':
      return `Finer ${offer.source.regionLabel.toLowerCase()} depth data is available here`;
    case 'unavailable':
      return 'Depth data for this area is unavailable right now';
    case 'offline':
      return 'Keep this area’s depth chart available offline';
  }
}
