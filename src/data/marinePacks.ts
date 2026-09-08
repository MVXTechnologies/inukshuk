import type { MarinePackRecord } from '@core/geo/marinePacks';
import { isMarineSourceId } from '@core/geo/marineSources';
import { isOutOfSpaceMessage } from '@core/storage/diskBudget';
import { Directory, File, Paths } from 'expo-file-system';

import * as storage from './storage';

/**
 * Offline marine packs on disk (marine wave D §D4). One raw float32 GeoTIFF
 * per 0.1° pack cell under `Paths.document/marine-packs/`, plus a small JSON
 * index so the Settings list and the auto-update sweep never have to stat
 * the whole directory.
 *
 * A single grid file per cell is the whole point: the client depth renderer
 * (`@core/geo/depthChart`) draws it AND tap-for-depth samples it, so a
 * downloaded reach needs no tile pyramid and works with the radio off. This
 * is the only slice of wave D that touches `src/data`.
 *
 * Everything here degrades silently: a missing directory, a truncated file
 * or a corrupt index reads as "no packs", never as an error the user sees.
 */

const PACKS_DIR = 'marine-packs';
const INDEX_FILE = 'marine-packs.json';

function packsDir(): Directory {
  return new Directory(Paths.document, PACKS_DIR);
}

/** Storage keys carry ':' — not portable in a filename. */
function fileName(key: string): string {
  return `${key.replace(/:/g, '_')}.tif`;
}

/** Prefer the last complete cell if a promotion was interrupted. */
function readableCell(key: string): File {
  const file = new File(packsDir(), fileName(key));
  const backup = new File(packsDir(), `${fileName(key)}.bak`);
  return !file.exists && backup.exists ? backup : file;
}

/** Absolute URI of a stored pack cell (whether or not it exists). */
export function packCellUri(key: string): string {
  return readableCell(key).uri;
}

export function packCellExists(key: string): boolean {
  try {
    return readableCell(key).exists;
  } catch {
    return false;
  }
}

/** Write a fetched cell; returns the bytes stored and throws on failure. */
export function writePackCell(key: string, bytes: Uint8Array): number {
  const dir = packsDir();
  const name = fileName(key);
  const file = new File(dir, name);
  const staged = new File(dir, `${name}.tmp`);
  const backup = new File(dir, `${name}.bak`);
  try {
    if (!dir.exists) dir.create({ intermediates: true });
    // Recover an interrupted promotion before attempting another replacement.
    if (!file.exists && backup.exists) backup.moveSync(file);
    if (staged.exists) staged.delete();
    staged.create();
    staged.write(bytes);
    // Expo's overwrite move deletes its destination first. Keep a backup until
    // the fully written stage has moved successfully, without overwriting it.
    const saved = new File(dir, `${name}.bak`);
    if (saved.exists) saved.delete();
    if (file.exists) file.moveSync(saved);
    staged.moveSync(new File(dir, name));
  } catch (err) {
    try {
      const saved = new File(dir, `${name}.bak`);
      const target = new File(dir, name);
      if (!target.exists && saved.exists) saved.moveSync(target);
    } catch {
      // Keep the backup readable even if rollback itself fails.
    }
    const message = err instanceof Error ? err.message : String(err);
    if (isOutOfSpaceMessage(message)) throw new storage.StorageFullError(message);
    throw err;
  } finally {
    try {
      // File.moveSync changes the instance URI: clean up using a fresh reference.
      const leftover = new File(dir, `${name}.tmp`);
      if (leftover.exists) leftover.delete();
    } catch {
      // A later attempt can discard the incomplete stage.
    }
  }
  try {
    const saved = new File(dir, `${name}.bak`);
    if (saved.exists) saved.delete();
  } catch {
    // The new cell is committed; a leftover backup is harmless.
  }
  return bytes.byteLength;
}

/** Read a stored cell's raw bytes, or null when it isn't there. */
export async function readPackCell(key: string): Promise<Uint8Array | null> {
  try {
    const file = readableCell(key);
    if (!file.exists) return null;
    return await file.bytes();
  } catch {
    return null;
  }
}

export function deletePackCell(key: string): void {
  for (const suffix of ['', '.bak', '.tmp']) {
    try {
      const file = new File(packsDir(), `${fileName(key)}${suffix}`);
      if (file.exists) file.delete();
    } catch {
      // Already gone / unreadable — the index write below is what matters.
    }
  }
}

/** Drop the whole directory (Settings → delete all). */
export function deleteAllPackCells(): void {
  try {
    const dir = packsDir();
    if (dir.exists) dir.delete();
  } catch {
    // Ignore — a stale directory is harmless.
  }
}

function isRecord(v: unknown): v is MarinePackRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  const bbox = r.bbox;
  if (typeof bbox !== 'object' || bbox === null) return false;
  const b = bbox as Record<string, unknown>;
  return (
    typeof r.key === 'string' &&
    isMarineSourceId(r.sourceId) &&
    typeof r.bytes === 'number' &&
    typeof r.updatedAt === 'number' &&
    typeof b.west === 'number' &&
    typeof b.south === 'number' &&
    typeof b.east === 'number' &&
    typeof b.north === 'number'
  );
}

/**
 * The pack index, filtered to records whose file is actually present — a
 * half-finished download or a manually cleared app directory must not leave
 * a phantom pack claiming to cover a region.
 */
export async function readPackIndex(): Promise<MarinePackRecord[]> {
  const raw = await storage.readJson<unknown>(INDEX_FILE);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).filter((r) => packCellExists(r.key));
}

export function writePackIndex(records: readonly MarinePackRecord[]): void {
  storage.writeJson(INDEX_FILE, records);
}
