import { sanitizeEntryName, uniquePath } from '@core/export/zipPaths';
import { formatBytes } from '@core/format';
import { groupByFolder } from '@core/library/folders';
import { areasToGeoJson } from '@core/draw/serialize';
import type { Area, Folder, MapDocument, TrackSummary, Waypoint } from '@core/models';

/**
 * Pure planning for Settings' "Download your data" ZIP — the full-fat export:
 * every imported map (PDF), every trail (GPX) and every photo (trail notes and
 * standalone waypoints), laid out to mirror how the Library organizes items.
 *
 * Structure (folders organize — and, since 1.3.0, activate): each Library folder becomes
 * a top-level directory in the archive; items with no folder sit at the archive
 * root, exactly like the Library's Ungrouped section. Bundles are additive
 * collections (an item can belong to several), not places — so they do NOT
 * become directories; their definitions travel in `library.json`, which the
 * platform layer packs verbatim at the archive root. Photos land in a
 * `photos/` directory inside the directory of the trail or waypoint that owns
 * them. Waypoints themselves have no file of their own (they live in
 * `library.json`), so a waypoint without a photo adds nothing to the tree —
 * but it still counts, and a library holding only waypoints is exportable:
 * the index alone is a valid, restorable archive.
 *
 * The plan is deterministic: folders in library order, then within each level
 * maps before trails before waypoints (the Library's own grouping), photos in
 * note/waypoint order. All file I/O (sizes, bytes, zipping, sharing) stays out
 * of `core`.
 */

export interface ArchiveEntry {
  /** Entry path inside the zip archive (e.g. `Alps 2026/Morning hike.gpx`, sanitized). */
  zipPath: string;
  /** App-storage uri to read the bytes from. */
  sourceUri: string;
  /** What the entry is — lets the caller report accurate counts. */
  kind: 'map' | 'gpx' | 'photo' | 'photo-list';
  /**
   * Whether the entry should be deflated. GPX is text and compresses well;
   * maps (PDF) and photos are already-compressed formats, so they are stored
   * as-is instead of burning CPU for ~0% gain on files that can be tens of MB.
   */
  deflate: boolean;
}

export interface ArchivePlan {
  entries: ArchiveEntry[];
  /** Number of map entries planned. */
  mapCount: number;
  /** Number of GPX entries planned. */
  trackCount: number;
  /**
   * Number of standalone waypoints in the library. They travel inside
   * `library.json` rather than as entries, so this is a summary count only.
   */
  waypointCount: number;
  /** Number of photo entries planned (trail notes, waypoints and areas, deduped by source). */
  photoCount: number;
  /** Number of drawn areas (#503); they travel in `library.json` and `areas.geojson`. */
  areaCount: number;
  /**
   * Generated text files packed alongside the stored ones — today the drawn
   * areas as one GeoJSON FeatureCollection, so they open in any GIS tool
   * without the app. Built here (pure) so the caller only zips them.
   */
  textEntries: { zipPath: string; text: string }[];
}

/** Name for the exported archive, e.g. `inukshuk-data-2026-07-14.zip`. */
export function dataArchiveName(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `inukshuk-data-${y}-${m}-${d}.zip`;
}

/** Lower-cased extension of a uri's basename (no dot), or null when it has none. */
function extensionOf(uri: string): string | null {
  const base = uri.split(/[?#]/)[0]?.split(/[/\\]/).pop() ?? '';
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(base);
  return match ? match[1]!.toLowerCase() : null;
}

/**
 * Reduce a Library display name (folder/map/trail) to a safe zip path segment.
 * Unlike {@link sanitizeEntryName} (built for uris — it keeps only the last
 * path segment), a slash in a display name is replaced, not split on, so
 * "Côte/Nord" stays one segment. `..` runs are neutralized (no traversal),
 * leading dots are stripped and the result is never empty.
 */
function sanitizeDisplayName(name: string): string {
  const clean = name
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^\.+/, '');
  return clean || 'item';
}

/** `<display name sanitized>.<ext>`, without doubling an already-present extension. */
function entryFileName(displayName: string, ext: string): string {
  const base = sanitizeDisplayName(displayName);
  return base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`;
}

/** The library snapshot the planner needs — a subset of the persisted index. */
export interface DataArchiveInput {
  folders: readonly Folder[];
  maps: readonly MapDocument[];
  tracks: readonly TrackSummary[];
  /** Standalone waypoints; only their photos become entries. */
  waypoints: readonly Waypoint[];
  /** Drawn areas (#503): photos under `areas/photos/`, shapes in `areas.geojson`. */
  areas?: readonly Area[];
  /**
   * Trail photos (#587), by trail id: each trail's display copies, and its
   * photo list (`photos.json`: captions, times, places) so the backup keeps
   * what the copies alone cannot. Packed under `photos/<trail name>/` beside
   * the trail's GPX.
   */
  trailPhotos?: ReadonlyMap<string, TrailPhotoFiles>;
}

/** One trail's photo files for the archive (app-storage uris). */
export interface TrailPhotoFiles {
  photos: readonly { id: string; file: string }[];
  /** The trail's photo list (sidecar), when it has one. */
  listUri?: string;
}

/**
 * Plan the "Download your data" archive. Entry names are sanitized and deduped
 * per directory-tree path (colliding names get `-2`, `-3`, …); a source uri
 * referenced twice (e.g. one photo shared by a note and a waypoint) is only
 * packed once, under the first owner encountered. The `library.json` slot at
 * the archive root is reserved for the caller.
 */
export function planDataArchive(input: DataArchiveInput): ArchivePlan {
  const { groups, ungroupedMaps, ungroupedTracks, ungroupedWaypoints } = groupByFolder(
    input.folders,
    input.maps,
    input.tracks,
    input.waypoints,
  );

  const entries: ArchiveEntry[] = [];
  const areas = input.areas ?? [];
  const textEntries =
    areas.length > 0 ? [{ zipPath: 'areas.geojson', text: areasToGeoJson(areas) }] : [];
  const takenPaths = new Set<string>(['library.json', ...textEntries.map((e) => e.zipPath)]);
  const takenDirs = new Set<string>();
  const seenSources = new Set<string>();
  let mapCount = 0;
  let trackCount = 0;
  let photoCount = 0;

  const addMap = (map: MapDocument, dir: string): void => {
    if (seenSources.has(map.fileUri)) return;
    seenSources.add(map.fileUri);
    // Maps keep their original format; everything imported today is a PDF, but
    // the extension follows the stored file rather than assuming.
    const ext = extensionOf(map.fileUri) ?? 'pdf';
    entries.push({
      zipPath: uniquePath(takenPaths, `${dir}${entryFileName(map.name, ext)}`),
      sourceUri: map.fileUri,
      kind: 'map',
      deflate: false,
    });
    mapCount++;
  };

  // One path for every photo, whoever owns it: a file shared by two notes, two
  // waypoints, or a note and a waypoint is packed exactly once.
  const addPhoto = (photoUri: string | undefined, dir: string): void => {
    if (!photoUri || seenSources.has(photoUri)) return;
    seenSources.add(photoUri);
    entries.push({
      zipPath: uniquePath(takenPaths, `${dir}photos/${sanitizeEntryName(photoUri)}`),
      sourceUri: photoUri,
      kind: 'photo',
      deflate: false,
    });
    photoCount++;
  };

  const addTrack = (track: TrackSummary, dir: string): void => {
    if (!seenSources.has(track.fileUri)) {
      seenSources.add(track.fileUri);
      entries.push({
        zipPath: uniquePath(takenPaths, `${dir}${entryFileName(track.name, 'gpx')}`),
        sourceUri: track.fileUri,
        kind: 'gpx',
        deflate: true,
      });
      trackCount++;
    }
    for (const note of track.notes ?? []) addPhoto(note.photoUri, dir);
    const trailPhotos = input.trailPhotos?.get(track.id);
    if (trailPhotos && trailPhotos.photos.length > 0) {
      // One folder per trail: photo ids are unique, but two trails' folders must not merge.
      const photoDir = `${uniquePath(takenDirs, `${dir}photos/${sanitizeDisplayName(track.name)}`)}/`;
      for (const photo of trailPhotos.photos) {
        if (seenSources.has(photo.file)) continue;
        seenSources.add(photo.file);
        entries.push({
          zipPath: uniquePath(takenPaths, `${photoDir}${entryFileName(photo.id, 'jpg')}`),
          sourceUri: photo.file,
          kind: 'photo',
          deflate: false,
        });
        photoCount++;
      }
      if (trailPhotos.listUri && !seenSources.has(trailPhotos.listUri)) {
        seenSources.add(trailPhotos.listUri);
        entries.push({
          zipPath: uniquePath(takenPaths, `${photoDir}photos.json`),
          sourceUri: trailPhotos.listUri,
          kind: 'photo-list',
          deflate: true,
        });
      }
    }
  };

  for (const group of groups) {
    // Two folders can share a display name; their directories must not merge.
    const dir = `${uniquePath(takenDirs, sanitizeDisplayName(group.folder.name))}/`;
    for (const map of group.maps) addMap(map, dir);
    for (const track of group.tracks) addTrack(track, dir);
    for (const waypoint of group.waypoints) addPhoto(waypoint.photoUri, dir);
  }
  for (const map of ungroupedMaps) addMap(map, '');
  for (const track of ungroupedTracks) addTrack(track, '');
  for (const waypoint of ungroupedWaypoints) addPhoto(waypoint.photoUri, '');
  for (const area of areas) for (const uri of area.photoUris ?? []) addPhoto(uri, 'areas/');

  return {
    entries,
    mapCount,
    trackCount,
    waypointCount: input.waypoints.length,
    photoCount,
    areaCount: areas.length,
    textEntries,
  };
}

/**
 * One-line summary of a plan for the Settings row, e.g.
 * `2 trails, 1 map, 3 waypoints, 4 photos · ~12 MB zip`. `sizeBytes` is the
 * caller-measured total of the planned files (I/O stays out of `core`).
 *
 * An archive is never "nothing to export": even an empty library yields a
 * restorable `library.json`, and a waypoint-only library has real data in it —
 * the summary says so instead of calling the library empty.
 */
export function describeDataArchive(plan: ArchivePlan, sizeBytes: number): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (plan.entries.length === 0 && plan.waypointCount === 0 && plan.areaCount === 0) {
    return 'Your library is empty · exports the index only';
  }
  const parts = [plural(plan.trackCount, 'trail'), plural(plan.mapCount, 'map')];
  if (plan.waypointCount > 0) parts.push(plural(plan.waypointCount, 'waypoint'));
  if (plan.areaCount > 0) parts.push(plural(plan.areaCount, 'area'));
  if (plan.photoCount > 0) parts.push(plural(plan.photoCount, 'photo'));
  // No files to pack (waypoints without photos): the size would read "0 KB",
  // which misdescribes a small-but-real index — say what the zip holds instead.
  const size = plan.entries.length === 0 ? 'index only' : `~${formatBytes(sizeBytes)} zip`;
  return `${parts.join(', ')} · ${size}`;
}
