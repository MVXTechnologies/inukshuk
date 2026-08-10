import { Directory, File, FileMode, Paths } from 'expo-file-system';
import { nanoid } from 'nanoid/non-secure';

import { isOutOfSpaceMessage } from '@core/storage/diskBudget';
import { singleFlight } from '@core/storage/singleFlight';

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
 * Thrown when a write fails because the device is out of storage (ENOSPC /
 * SQLITE_FULL / OEM phrasings). Distinguishing it lets callers say "you're out
 * of space" instead of a generic "couldn't save" — the disk-full case is a real
 * one on this dev's near-full device (#94).
 */
export class StorageFullError extends Error {
  constructor(cause: string) {
    super('Not enough free space to save — free up space and try again.');
    this.name = 'StorageFullError';
    // Keep the raw native reason for logs without leaking it into the UI copy.
    (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * Run a synchronous filesystem write, translating an out-of-space failure into
 * a {@link StorageFullError} so the cause is named. Other errors pass through
 * unchanged.
 */
function guardWrite<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isOutOfSpaceMessage(message)) throw new StorageFullError(message);
    throw err;
  }
}

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
  guardWrite(() => file.write(base64Png, { encoding: 'base64' }));
  return file.uri;
}

/**
 * Write raw PNG bytes into the cache and return a cache-busting `file://`
 * uri (marine wave D: the client-rendered depth-chart drape).
 *
 * Like {@link writeOverlayPng} this exists because MapLibre's Android
 * `ImageSource` cannot consume a `data:` URI — but it takes BYTES, skipping
 * the base64 round trip a multi-megabyte chart bitmap would otherwise pay on
 * every camera settle (`File.write` accepts a Uint8Array directly in SDK 56).
 *
 * The file NAME carries a timestamp: MapLibre caches image sources by URL,
 * so re-rendering a region must hand it a URL it has not seen or the stale
 * bitmap stays on screen. Older renders of the same id are deleted first, so
 * the cache holds at most one file per chart id.
 */
export function writeChartPng(id: string, bytes: Uint8Array): string {
  const dir = overlaysDir();
  if (!dir.exists) dir.create({ intermediates: true });
  for (const existing of dir.list()) {
    if (existing instanceof File && existing.name.startsWith(`${id}_`)) existing.delete();
  }
  const file = new File(dir, `${id}_${Date.now()}.png`);
  if (file.exists) file.delete();
  file.create();
  guardWrite(() => file.write(bytes));
  return file.uri;
}

export async function readFileBytes(uri: string): Promise<Uint8Array> {
  return new File(uri).bytes();
}

/** Thrown by {@link downloadBytes} when offline-only mode is on and the file is not cached. */
export class OfflineOnlyError extends Error {
  constructor(name: string) {
    super(`offline-only: ${name} not cached`);
    this.name = 'OfflineOnlyError';
  }
}

// One switch governs ALL tile traffic. MapLibre's own fetches are gated natively
// via NetworkManager.setConnected; the raw 3D DEM/basemap fetches all flow through
// downloadBytes, which honors this flag. Toggled by offline.setOfflineOnly().
let networkAllowed = true;

/** Allow (true) or forbid (false) network fetches in {@link downloadBytes}. */
export function setNetworkAllowed(allowed: boolean): void {
  networkAllowed = allowed;
}

// ---- DEM/basemap tile cache eviction --------------------------------------
// Paths.cache/dem would otherwise grow without bound (every 3D pan streams new
// tiles). After every EVICTION_CHECK_EVERY successful downloads we scan the dir
// and, if it exceeds the cap, delete oldest-modified files down to ~75% of cap.

const DEM_CACHE_CAP_BYTES = 128 * 1024 * 1024; // 128 MB
const EVICTION_TARGET_RATIO = 0.75; // shrink to 75% of cap so evictions are infrequent
const EVICTION_CHECK_EVERY = 32; // downloads between cache-size checks
let downloadsSinceEvictionCheck = 0;

/** A cache file as seen by the eviction policy. */
export interface CacheEntry {
  name: string;
  /** Size in bytes. */
  size: number;
  /** Last-modified time (ms since epoch); older files are evicted first. */
  mtime: number;
}

/**
 * Pure eviction policy (exported for unit tests — no FS access). Given the cache
 * contents and a byte cap, returns the names to delete, oldest-modified first,
 * until the remaining total is at or below `capBytes * EVICTION_TARGET_RATIO`.
 * Returns `[]` when the total is already within the cap.
 */
export function pickEvictions(entries: CacheEntry[], capBytes: number): string[] {
  let total = entries.reduce((sum, e) => sum + e.size, 0);
  if (total <= capBytes) return [];
  const target = capBytes * EVICTION_TARGET_RATIO;
  const oldestFirst = [...entries].sort((a, b) => a.mtime - b.mtime);
  const evict: string[] = [];
  for (const entry of oldestFirst) {
    if (total <= target) break;
    evict.push(entry.name);
    total -= entry.size;
  }
  return evict;
}

/** Best-effort LRU-ish eviction; runs at most once per EVICTION_CHECK_EVERY downloads. */
function maybeEvictDemCache(dir: Directory): void {
  downloadsSinceEvictionCheck += 1;
  if (downloadsSinceEvictionCheck < EVICTION_CHECK_EVERY) return;
  downloadsSinceEvictionCheck = 0;
  try {
    const files = dir.list().filter((entry): entry is File => entry instanceof File);
    const entries: CacheEntry[] = files.map((f) => ({
      name: f.name,
      size: f.size,
      mtime: f.modificationTime ?? 0,
    }));
    const doomed = new Set(pickEvictions(entries, DEM_CACHE_CAP_BYTES));
    for (const f of files) {
      if (doomed.has(f.name)) f.delete();
    }
  } catch {
    /* eviction is best-effort — never let it break a fetch */
  }
}

// One shared, evicted cache directory for every raw downloaded tile (DEM,
// 3D-drape basemap, region-preview). The name is historical: it started as the
// DEM-only cache.
const TILE_CACHE_DIR = 'dem';

/** Thrown by {@link downloadBytes} when the server's 200 body fails `validate`. */
export class InvalidTileError extends Error {
  constructor(name: string) {
    super(`invalid tile response: ${name}`);
    this.name = 'InvalidTileError';
  }
}

// In-flight downloads keyed by cache file name. Concurrent callers of the same
// tile share ONE download instead of racing on the same destination file —
// on iOS, expo-file-system checks the destination when the download COMPLETES
// and throws DestinationAlreadyExistsException if the other racer landed first
// (FileSystemDownload.swift:160, issue #126). Android tolerated the race.
const inflightDownloads = new Map<string, Promise<Uint8Array>>();

/**
 * Download a remote file (e.g. a DEM/basemap tile) into the cache and return its
 * raw bytes. Reliable for binary, unlike RN's `fetch().arrayBuffer()`.
 *
 * Tiles are immutable (a given z/x/y never changes), so a cached file is reused
 * on subsequent calls. This is essential once the 3D view streams terrain as you
 * move: overlapping tiles between map positions are served from disk instead of
 * re-downloaded, which keeps it fast and avoids tripping tile-server rate limits.
 *
 * Safe for concurrent callers of the same url/name: duplicates await the same
 * in-flight download (see {@link singleFlight}), and the download itself is
 * `idempotent` so a leftover/stale destination file is overwritten instead of
 * throwing `DestinationAlreadyExistsException` on iOS (#126).
 *
 * `validate` (optional) inspects the bytes: a cached entry that fails it is
 * deleted and re-downloaded; a fresh download that fails it is deleted and
 * rejected with {@link InvalidTileError} — so a policy/error tile served with
 * HTTP 200 can neither render nor poison the cache (#129).
 *
 * In offline-only mode ({@link setNetworkAllowed}) cached tiles still serve
 * normally, but a cache miss throws {@link OfflineOnlyError} instead of fetching.
 */
export function downloadBytes(
  url: string,
  name: string,
  headers?: Record<string, string>,
  validate?: (bytes: Uint8Array) => boolean,
): Promise<Uint8Array> {
  return singleFlight(inflightDownloads, name, () =>
    downloadBytesUncontended(url, name, headers, validate),
  );
}

async function downloadBytesUncontended(
  url: string,
  name: string,
  headers?: Record<string, string>,
  validate?: (bytes: Uint8Array) => boolean,
): Promise<Uint8Array> {
  const dir = new Directory(Paths.cache, TILE_CACHE_DIR);
  if (!dir.exists) dir.create({ intermediates: true });
  const dest = new File(dir, name);
  if (dest.exists) {
    try {
      const cached = await dest.bytes();
      if (cached.length > 0 && (validate === undefined || validate(cached))) {
        return cached; // cache hit
      }
    } catch {
      /* unreadable cache entry — fall through and re-download */
    }
    dest.delete(); // empty, corrupt, or validation-rejected (poisoned) entry
  }
  if (!networkAllowed) throw new OfflineOnlyError(name);
  // `idempotent`: overwrite a destination that (re)appeared since the check
  // above — without it iOS throws DestinationAlreadyExistsException (#126).
  await File.downloadFileAsync(url, dest, { idempotent: true, ...(headers ? { headers } : {}) });
  const bytes = await dest.bytes();
  if (validate !== undefined && !validate(bytes)) {
    try {
      dest.delete();
    } catch {
      /* best-effort — the next call's cache validation re-deletes it */
    }
    throw new InvalidTileError(name);
  }
  maybeEvictDemCache(dir);
  return bytes;
}

/**
 * Like {@link downloadBytes} (same cache, same offline-only + validation
 * behaviour), but returns the cached file's `file://` uri instead of its bytes —
 * for consumers that hand the tile straight to an `<Image>` rather than
 * decoding it.
 */
export async function downloadToCacheUri(
  url: string,
  name: string,
  headers?: Record<string, string>,
  validate?: (bytes: Uint8Array) => boolean,
): Promise<string> {
  await downloadBytes(url, name, headers, validate);
  return new File(new Directory(Paths.cache, TILE_CACHE_DIR), name).uri;
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

/** Write generated PDF bytes (a made map) into the maps store; returns its uri. */
export function writeMapPdfBytes(id: string, bytes: Uint8Array): string {
  ensureStorage();
  const file = new File(mapsDir(), `${id}.pdf`);
  if (file.exists) file.delete();
  file.create();
  guardWrite(() => file.write(bytes));
  return file.uri;
}

/** Write a GPX (or any text) document and return its uri. */
export function writeTrackGpx(id: string, gpx: string): string {
  ensureStorage();
  const file = new File(tracksDir(), `${id}.gpx`);
  if (file.exists) file.delete();
  file.create();
  guardWrite(() => file.write(gpx));
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
  guardWrite(() => staged.write(JSON.stringify(value)));
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

/**
 * Raw text of the persisted library index (`library.json`), or null if it has
 * never been written. Used by the data export, which packs the on-disk index
 * verbatim rather than a re-serialization.
 */
export async function readIndexText(): Promise<string | null> {
  const file = new File(Paths.document, INDEX_FILE);
  return file.exists ? file.text() : null;
}

/** Size in bytes of the file at `uri`, or 0 when it does not exist / cannot be read. */
export function fileSizeAt(uri: string): number {
  try {
    return new File(uri).size;
  } catch {
    return 0;
  }
}

/**
 * Stream a file's bytes through `onChunk` in `chunkSize` slices, without ever
 * holding the whole file in memory — imported maps can run to tens of MB.
 * `final` is true exactly once, on the last chunk (an empty file yields a
 * single empty final chunk).
 */
export function readFileChunks(
  uri: string,
  chunkSize: number,
  onChunk: (chunk: Uint8Array, final: boolean) => void,
): void {
  const handle = new File(uri).open(FileMode.ReadOnly);
  try {
    const total = handle.size ?? 0;
    if (total === 0) {
      onChunk(new Uint8Array(0), true);
      return;
    }
    let read = 0;
    while (read < total) {
      const chunk = handle.readBytes(Math.min(chunkSize, total - read));
      read += chunk.length;
      // A short read means the file shrank underneath us; still emit `final`
      // exactly once so streaming consumers (zip entries) are always closed.
      onChunk(chunk, read >= total || chunk.length === 0);
      if (chunk.length === 0) break;
    }
  } finally {
    handle.close();
  }
}

/** Incremental writer into the cache `exports/` staging area. */
export interface CacheFileWriter {
  uri: string;
  write(chunk: Uint8Array): void;
  /** Flush and release the handle. Idempotent. */
  close(): void;
}

/**
 * Open a cache `exports/<name>` file for sequential appends and return a
 * writer — for archives assembled chunk-by-chunk (streamed zips) that must not
 * be buffered whole in memory. Callers should {@link deleteFileAt} the uri
 * once the share sheet resolves.
 */
export function createCacheFileWriter(name: string): CacheFileWriter {
  const dir = new Directory(Paths.cache, 'exports');
  if (!dir.exists) dir.create({ intermediates: true });
  const file = new File(dir, name);
  if (file.exists) file.delete();
  file.create();
  const handle = file.open(FileMode.Append);
  let closed = false;
  return {
    uri: file.uri,
    write: (chunk) => handle.writeBytes(chunk),
    close: () => {
      if (closed) return;
      closed = true;
      handle.close();
    },
  };
}
