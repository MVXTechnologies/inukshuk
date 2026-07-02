import { Directory, File, Paths } from 'expo-file-system';
import { nanoid } from 'nanoid/non-secure';

/**
 * Platform-coupled persistence for Inukshuk. Lives outside `src/core` (which stays
 * pure/testable). Uses the SDK 56 File/Directory API.
 *
 * Layout under the app document directory:
 *   maps/<id>.pdf      imported georeferenced PDFs
 *   tracks/<id>.gpx    saved recordings
 *   library.json       index of MapDocuments + track metadata
 */

const MAPS_DIR = 'maps';
const TRACKS_DIR = 'tracks';
const PHOTOS_DIR = 'photos';
const INDEX_FILE = 'library.json';

function mapsDir(): Directory {
  return new Directory(Paths.document, MAPS_DIR);
}
function tracksDir(): Directory {
  return new Directory(Paths.document, TRACKS_DIR);
}
function photosDir(): Directory {
  return new Directory(Paths.document, PHOTOS_DIR);
}

/** Create the storage directories if they do not exist. Safe to call repeatedly. */
export function ensureStorage(): void {
  for (const dir of [mapsDir(), tracksDir(), photosDir()]) {
    if (!dir.exists) dir.create({ intermediates: true });
  }
}

export const newId = (): string => nanoid(12);

/**
 * Copy a picked PDF into app storage under a stable id. Returns the new file
 * uri. The original (often a temporary cache file from the picker) is untouched.
 */
export async function importPdf(sourceUri: string, id: string): Promise<string> {
  ensureStorage();
  const source = new File(sourceUri);
  const dest = new File(mapsDir(), `${id}.pdf`);
  if (dest.exists) dest.delete();
  await source.copy(dest);
  return dest.uri;
}

/**
 * Copy a picked GPX file into app storage under a stable id. Returns the new
 * file uri. Mirrors {@link importPdf} for imported trails.
 */
export async function importGpx(sourceUri: string, id: string): Promise<string> {
  ensureStorage();
  const source = new File(sourceUri);
  const dest = new File(tracksDir(), `${id}.gpx`);
  if (dest.exists) dest.delete();
  await source.copy(dest);
  return dest.uri;
}

export async function readFileBase64(uri: string): Promise<string> {
  return new File(uri).base64();
}

/**
 * Copy a picked image (trail-note photo) into app storage under a stable id,
 * preserving its extension. Returns the new file uri; the picker's temp file is
 * left untouched.
 */
export async function importPhoto(sourceUri: string, id: string): Promise<string> {
  ensureStorage();
  const ext = sourceUri.split('?')[0]?.match(/\.(jpe?g|png|heic|webp)$/i)?.[0] ?? '.jpg';
  const source = new File(sourceUri);
  const dest = new File(photosDir(), `${id}${ext.toLowerCase()}`);
  if (dest.exists) dest.delete();
  await source.copy(dest);
  return dest.uri;
}

function overlaysDir(): Directory {
  return new Directory(Paths.cache, 'overlays');
}

/**
 * Write a base64-encoded PNG into the cache and return its `file://` uri.
 *
 * MapLibre's Android `ImageSource` cannot consume a `data:` URI — `setURL` builds
 * a `java.net.URL` from it, which throws (no `data` protocol handler), then falls
 * back to loading drawable resource id 0 and crashes the app. Overlays must be
 * backed by a real file URL, so we materialize the rasterized page to disk.
 */
export function writeOverlayPng(id: string, base64Png: string): string {
  const dir = overlaysDir();
  if (!dir.exists) dir.create({ intermediates: true });
  const file = new File(dir, `${id}.png`);
  if (file.exists) file.delete();
  file.create();
  file.write(base64Png, { encoding: 'base64' });
  return file.uri;
}

export async function readFileBytes(uri: string): Promise<Uint8Array> {
  return new File(uri).bytes();
}

/**
 * Download a remote file (e.g. a DEM/basemap tile) into the cache and return its
 * raw bytes. Reliable for binary, unlike RN's `fetch().arrayBuffer()`.
 *
 * Tiles are immutable (a given z/x/y never changes), so a cached file is reused
 * on subsequent calls. This is essential once the 3D view streams terrain as you
 * move: overlapping tiles between map positions are served from disk instead of
 * re-downloaded, which keeps it fast and avoids tripping tile-server rate limits.
 */
export async function downloadBytes(
  url: string,
  name: string,
  headers?: Record<string, string>,
): Promise<Uint8Array> {
  const dir = new Directory(Paths.cache, 'dem');
  if (!dir.exists) dir.create({ intermediates: true });
  const dest = new File(dir, name);
  if (dest.exists) {
    try {
      const cached = await dest.bytes();
      if (cached.length > 0) return cached; // cache hit
    } catch {
      /* unreadable cache entry — fall through and re-download */
    }
    dest.delete();
  }
  await File.downloadFileAsync(url, dest, headers ? { headers } : undefined);
  return dest.bytes();
}

/**
 * Read a file's text from any URI — including the content:// URIs delivered by
 * Android "Open with" intents (the picker only ever gives us a cached file://).
 *
 * Fallback if File.text() can't read content:// on a device:
 *   import * as LegacyFS from 'expo-file-system/legacy';
 *   return LegacyFS.readAsStringAsync(uri);
 */
export async function readFileText(uri: string): Promise<string> {
  return new File(uri).text();
}

/** Write a GPX (or any text) document and return its uri. */
export function writeTrackGpx(id: string, gpx: string): string {
  ensureStorage();
  const file = new File(tracksDir(), `${id}.gpx`);
  if (file.exists) file.delete();
  file.create();
  file.write(gpx);
  return file.uri;
}

export function deleteFileAt(uri: string): void {
  const file = new File(uri);
  if (file.exists) file.delete();
}

export function fileExists(uri: string): boolean {
  return new File(uri).exists;
}

/**
 * Read a JSON document stored at the document root, or null if absent/corrupt.
 *
 * Recovery order: the file itself, then the `.tmp` staging file (covers a crash
 * between {@link writeJson}'s delete and move). A file that exists but fails to
 * parse is preserved as `<name>.corrupt` instead of being silently discarded,
 * so a torn write never silently costs the user their data.
 */
export async function readJson<T>(name: string): Promise<T | null> {
  const file = new File(Paths.document, name);
  if (file.exists) {
    try {
      return JSON.parse(await file.text()) as T;
    } catch {
      try {
        const evidence = new File(Paths.document, `${name}.corrupt`);
        if (evidence.exists) evidence.delete();
        file.copy(evidence);
      } catch {
        /* best-effort forensics only */
      }
    }
  }
  const staged = new File(Paths.document, `${name}.tmp`);
  if (staged.exists) {
    try {
      return JSON.parse(await staged.text()) as T;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Write a JSON document atomically: stage the full payload in `<name>.tmp`,
 * then swap it into place. A kill mid-write can no longer truncate the target
 * (the previous version survives, or the completed staging file is recovered
 * by {@link readJson}) — this index is rewritten on every library mutation, so
 * torn writes were a real data-loss path.
 */
export function writeJson(name: string, value: unknown): void {
  const staged = new File(Paths.document, `${name}.tmp`);
  if (staged.exists) staged.delete();
  staged.create();
  staged.write(JSON.stringify(value));
  const file = new File(Paths.document, name);
  if (file.exists) file.delete();
  staged.move(file);
}

/** Read the persisted library index, or null if it has never been written. */
export function readIndex<T>(): Promise<T | null> {
  return readJson<T>(INDEX_FILE);
}

export function writeIndex(value: unknown): void {
  writeJson(INDEX_FILE, value);
}
