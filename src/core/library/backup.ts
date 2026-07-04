import type { TrackSummary } from '@core/models';

/**
 * Pure planning for the Library's "Export backup" ZIP. Decides what goes in the
 * archive and under which entry names; the file I/O (reading bytes, zipping,
 * sharing) stays in the feature layer.
 *
 * V1 backup contents: `library.json` (the persisted index verbatim — added by
 * the feature layer), every trail's `tracks/*.gpx` and every note photo under
 * `photos/*`. Maps (`maps/*.pdf`) are deliberately excluded: they can run to
 * hundreds of MB and the zip is assembled in memory.
 */

export interface BackupEntry {
  /** Entry path inside the zip archive (e.g. `tracks/abc123.gpx`). */
  zipPath: string;
  /** App-storage uri to read the bytes from. */
  sourceUri: string;
  /** What the entry is — lets the caller report accurate counts. */
  kind: 'gpx' | 'photo';
  /**
   * Whether the entry should be deflated. GPX is text and compresses well;
   * photos (JPEG/PNG/HEIC/WebP) are already compressed, so they are stored
   * as-is instead of burning CPU for ~0% gain.
   */
  deflate: boolean;
}

export interface BackupPlan {
  entries: BackupEntry[];
  /** Number of GPX entries planned. */
  trackCount: number;
  /** Number of photo entries planned. */
  photoCount: number;
}

/**
 * Reduce a uri/path to a safe zip entry basename: last path segment, query and
 * fragment stripped, percent-escapes decoded, and anything outside
 * `[A-Za-z0-9._-]` replaced. Never returns an empty string.
 */
export function sanitizeEntryName(uriOrName: string): string {
  const lastSegment = uriOrName.split(/[?#]/)[0]?.split(/[/\\]/).pop() ?? '';
  let decoded = lastSegment;
  try {
    decoded = decodeURIComponent(lastSegment);
  } catch {
    // Malformed escapes: keep the raw segment; it is sanitized below anyway.
  }
  const clean = decoded.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return clean || 'file';
}

/** Claim `path` in `taken`, suffixing `-2`, `-3`, … before the extension on collision. */
function uniquePath(taken: Set<string>, path: string): string {
  if (!taken.has(path)) {
    taken.add(path);
    return path;
  }
  const dot = path.lastIndexOf('.');
  const stem = dot > 0 ? path.slice(0, dot) : path;
  const ext = dot > 0 ? path.slice(dot) : '';
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

/** Name for the exported archive, e.g. `inukshuk-backup-2026-07-03.zip`. */
export function backupZipName(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `inukshuk-backup-${y}-${m}-${d}.zip`;
}

/**
 * Plan the backup entries for the given trails: one `tracks/<name>.gpx` per
 * trail plus one `photos/<name>` per note photo. Entry names are sanitized and
 * deduped (colliding basenames get `-2`, `-3`, …); a source uri referenced
 * twice (e.g. one photo shared by two notes) is only packed once. The
 * `library.json` slot at the archive root is reserved by the caller.
 */
export function planBackup(tracks: readonly TrackSummary[]): BackupPlan {
  const entries: BackupEntry[] = [];
  const takenPaths = new Set<string>(['library.json']);
  const seenSources = new Set<string>();

  let trackCount = 0;
  let photoCount = 0;

  for (const track of tracks) {
    if (!seenSources.has(track.fileUri)) {
      seenSources.add(track.fileUri);
      entries.push({
        zipPath: uniquePath(takenPaths, `tracks/${sanitizeEntryName(track.fileUri)}`),
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
        zipPath: uniquePath(takenPaths, `photos/${sanitizeEntryName(note.photoUri)}`),
        sourceUri: note.photoUri,
        kind: 'photo',
        deflate: false,
      });
      photoCount++;
    }
  }

  return { entries, trackCount, photoCount };
}
