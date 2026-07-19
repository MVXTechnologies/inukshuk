import { sanitizeEntryName, uniquePath } from '@core/export/zipPaths';
import { groupByFolder } from '@core/library/folders';
import type { Folder, MapDocument, TrackSummary } from '@core/models';

/**
 * Pure planning for Settings' "Download your data" ZIP — the full-fat export:
 * every imported map (PDF), every trail (GPX) and every note photo, laid out to
 * mirror how the Library organizes items.
 *
 * Structure (folders organize — and, since 1.3.0, activate): each Library folder becomes
 * a top-level directory in the archive; items with no folder sit at the archive
 * root, exactly like the Library's Ungrouped section. Bundles are additive
 * collections (an item can belong to several), not places — so they do NOT
 * become directories; their definitions travel in `library.json`, which the
 * platform layer packs verbatim at the archive root. Note photos land in a
 * `photos/` directory next to their trail's GPX.
 *
 * The plan is deterministic: folders in library order, then within each level
 * maps before trails (the Library's own grouping), photos in note order. All
 * file I/O (sizes, bytes, zipping, sharing) stays out of `core`.
 */

export interface ArchiveEntry {
  /** Entry path inside the zip archive (e.g. `Alps 2026/Morning hike.gpx`, sanitized). */
  zipPath: string;
  /** App-storage uri to read the bytes from. */
  sourceUri: string;
  /** What the entry is — lets the caller report accurate counts. */
  kind: 'map' | 'gpx' | 'photo';
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
  /** Number of note-photo entries planned. */
  photoCount: number;
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
}

/**
 * Plan the "Download your data" archive. Entry names are sanitized and deduped
 * per directory-tree path (colliding names get `-2`, `-3`, …); a source uri
 * referenced twice (e.g. one photo shared by two notes) is only packed once.
 * The `library.json` slot at the archive root is reserved for the caller.
 */
export function planDataArchive(input: DataArchiveInput): ArchivePlan {
  // Waypoints live in library.json only (no per-waypoint files to pack), so
  // the archive tree ignores their folder assignment.
  const { groups, ungroupedMaps, ungroupedTracks } = groupByFolder(
    input.folders,
    input.maps,
    input.tracks,
    [],
  );

  const entries: ArchiveEntry[] = [];
  const takenPaths = new Set<string>(['library.json']);
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
    for (const note of track.notes ?? []) {
      if (!note.photoUri || seenSources.has(note.photoUri)) continue;
      seenSources.add(note.photoUri);
      entries.push({
        zipPath: uniquePath(takenPaths, `${dir}photos/${sanitizeEntryName(note.photoUri)}`),
        sourceUri: note.photoUri,
        kind: 'photo',
        deflate: false,
      });
      photoCount++;
    }
  };

  for (const group of groups) {
    // Two folders can share a display name; their directories must not merge.
    const dir = `${uniquePath(takenDirs, sanitizeDisplayName(group.folder.name))}/`;
    for (const map of group.maps) addMap(map, dir);
    for (const track of group.tracks) addTrack(track, dir);
  }
  for (const map of ungroupedMaps) addMap(map, '');
  for (const track of ungroupedTracks) addTrack(track, '');

  return { entries, mapCount, trackCount, photoCount };
}
