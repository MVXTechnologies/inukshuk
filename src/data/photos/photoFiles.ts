import { Directory, File } from 'expo-file-system';

import { stripJpegMetadata } from '@core/photos/jpegStrip';
import {
  inboxPath,
  orphanFiles,
  PHOTO_INBOX,
  PHOTOS_ROOT,
  photoFilePaths,
  photoIdOfFile,
  trailPhotoDir,
  type PhotoFilePaths,
} from '@core/photos/paths';
import { isOutOfSpaceMessage } from '@core/storage/diskBudget';
import { copyToServed } from '@data/localServer';
import { resolveDocumentPath, StorageFullError } from '@data/storage';

/**
 * Trail photo files (#587): the three copies per photo under
 * `photos/<trackId>/`, the resize inbox, deletion and housekeeping. Paths in
 * and out are document-relative (see `@core/photos/paths`); they are resolved
 * against the current document directory at every call (#247).
 *
 * Location stripping: the optimized copies come out of a canvas and carry no
 * metadata at all; a "Full size" copy goes through `stripJpegMetadata`, which
 * drops EXIF (GPS), XMP, IPTC, MPF, comments and anything appended after the
 * image (a Motion Photo's MP4, Ultra HDR gain maps), keeping the orientation
 * and the ICC profile.
 */

const fileAt = (path: string) => new File(resolveDocumentPath(path));
const dirAt = (path: string) => new Directory(resolveDocumentPath(path));

function ensureDir(path: string): void {
  const dir = dirAt(path);
  if (!dir.exists) dir.create({ intermediates: true });
}

function quietDelete(path: string): void {
  try {
    const f = fileAt(path);
    if (f.exists) f.delete();
  } catch {
    // Already gone; an orphan sweep catches anything left.
  }
}

/** Run a write, naming the out-of-space failure (#94) and cleaning up on any failure. */
function guarded<T>(paths: readonly string[], fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    for (const p of paths) {
      quietDelete(p);
      quietDelete(`${p}.tmp`);
    }
    const message = err instanceof Error ? err.message : String(err);
    if (isOutOfSpaceMessage(message)) throw new StorageFullError(message);
    throw err;
  }
}

/** Stage then promote, so a crash never leaves a half-written file under the final name. */
function writeStaged(path: string, data: string | Uint8Array, base64: boolean): void {
  const staged = fileAt(`${path}.tmp`);
  if (staged.exists) staged.delete();
  staged.create();
  if (base64 && typeof data === 'string') staged.write(data, { encoding: 'base64' });
  else staged.write(data);
  staged.moveSync(fileAt(path), { overwrite: true });
}

export interface WrittenCopies {
  paths: PhotoFilePaths;
  /** All three files, bytes. */
  bytes: number;
  /** `md5:<hex>` of the display copy, when the platform can hash it. */
  contentHash?: string;
}

function sizeOf(path: string): number {
  try {
    return fileAt(path).size ?? 0;
  } catch {
    return 0;
  }
}

function md5Of(path: string): string | undefined {
  try {
    const md5 = fileAt(path).info({ md5: true }).md5;
    return md5 ? `md5:${md5}` : undefined;
  } catch {
    return undefined;
  }
}

function finish(paths: PhotoFilePaths): WrittenCopies {
  const out: WrittenCopies = {
    paths,
    bytes: sizeOf(paths.file) + sizeOf(paths.thumb) + sizeOf(paths.sprite),
  };
  const hash = md5Of(paths.file);
  if (hash) out.contentHash = hash;
  return out;
}

/**
 * Write the worker's three outputs (base64) as a photo's copies. These MUST be
 * canvas re-encodes (the resize worker's output), which carry no metadata.
 * Never pass source bytes here: a copy that keeps the original file's bytes
 * goes through {@link writeFullSizeCopies}, which strips it first.
 */
export function writePhotoCopies(
  trackId: string,
  photoId: string,
  outputs: { display: string; thumb: string; sprite: string },
): WrittenCopies {
  const paths = photoFilePaths(trackId, photoId);
  const all = [paths.file, paths.thumb, paths.sprite];
  return guarded(all, () => {
    ensureDir(trailPhotoDir(trackId));
    writeStaged(paths.file, outputs.display, true);
    writeStaged(paths.thumb, outputs.thumb, true);
    writeStaged(paths.sprite, outputs.sprite, true);
    return finish(paths);
  });
}

/**
 * "Full size" (owner Q4's option): keep the picked JPEG itself as the display
 * copy, with its metadata stripped, plus the worker's thumb and sprite.
 * Throws for a non-JPEG source; the caller keeps the optimized copy instead.
 */
export async function writeFullSizeCopies(
  trackId: string,
  photoId: string,
  sourceUri: string,
  outputs: { thumb: string; sprite: string },
): Promise<WrittenCopies> {
  const source = await new File(sourceUri).bytes();
  const stripped = stripJpegMetadata(source);
  if (!stripped.jpeg) throw new Error('Full size keeps JPEG photos only');
  const paths = photoFilePaths(trackId, photoId);
  return guarded([paths.file, paths.thumb, paths.sprite], () => {
    ensureDir(trailPhotoDir(trackId));
    writeStaged(paths.file, stripped.bytes, false);
    writeStaged(paths.thumb, outputs.thumb, true);
    writeStaged(paths.sprite, outputs.sprite, true);
    return finish(paths);
  });
}

/** Delete one photo's copies. Best effort: an orphan sweep catches leftovers. */
export function deletePhotoFiles(paths: Pick<PhotoFilePaths, 'file' | 'thumb' | 'sprite'>): void {
  for (const p of new Set([paths.file, paths.thumb, paths.sprite])) quietDelete(p);
}

/** Delete a trail's whole photo folder (the trail itself was deleted). */
export function deleteTrailPhotos(trackId: string): void {
  try {
    const dir = dirAt(trailPhotoDir(trackId));
    if (dir.exists) dir.delete();
  } catch {
    // Nothing to delete, or already gone.
  }
}

/** File names in a trail's photo folder. */
export function listTrailPhotoFiles(trackId: string): string[] {
  const dir = dirAt(trailPhotoDir(trackId));
  if (!dir.exists) return [];
  return dir
    .list()
    .filter((e): e is File => e instanceof File)
    .map((f) => f.name);
}

/** Delete copies no live photo references; returns how many files went. */
export function sweepTrailOrphans(trackId: string, referencedIds: ReadonlySet<string>): number {
  const dir = trailPhotoDir(trackId);
  const orphans = orphanFiles(listTrailPhotoFiles(trackId), referencedIds);
  for (const name of orphans) quietDelete(`${dir}/${name}`);
  return orphans.length;
}

/**
 * Trail ids that have a photo folder. The flat `photos/<id>.<ext>` files next
 * to them are note / waypoint / area photos and are never listed or touched.
 */
export function trailsWithPhotos(): string[] {
  const root = dirAt(PHOTOS_ROOT);
  if (!root.exists) return [];
  return root
    .list()
    .filter((e): e is Directory => e instanceof Directory)
    .map((d) => d.name);
}

export interface PhotoUsage {
  photos: number;
  trails: number;
  bytes: number;
}

/** Settings → Photos: "33 photos on 2 trails · 19 MB". */
export function photoStorageUsage(): PhotoUsage {
  const usage: PhotoUsage = { photos: 0, trails: 0, bytes: 0 };
  for (const trackId of trailsWithPhotos()) {
    const ids = new Set<string>();
    for (const name of listTrailPhotoFiles(trackId)) {
      const id = photoIdOfFile(name);
      if (id === null) continue;
      ids.add(id);
      usage.bytes += sizeOf(`${trailPhotoDir(trackId)}/${name}`);
    }
    if (ids.size > 0) {
      usage.trails++;
      usage.photos += ids.size;
    }
  }
  return usage;
}

/** Settings → "Delete all photo copies". The user's photo library is not touched. */
export function deleteAllTrailPhotos(): number {
  const trails = trailsWithPhotos();
  for (const trackId of trails) deleteTrailPhotos(trackId);
  return trails.length;
}

/** Lower-case extension of a picked file, for the inbox name. */
export function extensionOf(uri: string): string {
  const m = /\.([A-Za-z0-9]{1,5})(?:[?#].*)?$/.exec(uri);
  return m ? m[1]!.toLowerCase() : 'jpg';
}

/** Copy a picked photo into the served inbox for the resize worker; returns its document path. */
export async function stageForResize(sourceUri: string, jobId: string): Promise<string> {
  const path = inboxPath(jobId, extensionOf(sourceUri));
  await copyToServed(sourceUri, path);
  return path;
}

export function unstage(documentPath: string): void {
  quietDelete(documentPath);
}

/**
 * Empty the inbox (at launch: anything there is left from a crash, and it is
 * full-resolution photos WITH their EXIF/GPS, in a folder the loopback server
 * serves).
 *
 * TODO(#587 stage 2): call this from the app's launch path before any import
 * can start. `inbox.guard.test.ts` fails once app code uses the resizer
 * without a call to it.
 */
export function clearPhotoInbox(): void {
  try {
    const dir = dirAt(PHOTO_INBOX);
    if (dir.exists) dir.delete();
  } catch {
    // best effort
  }
}
