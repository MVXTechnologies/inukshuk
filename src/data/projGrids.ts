/**
 * Grid packs on disk for the Convert tool (CONVERT §3): one directory per
 * pack under `Paths.document/proj-grids/<pack>/` with the pack's manifest,
 * and the Worker's pack index cached beside them, so Convert works offline
 * once a pack is here.
 *
 * Every file is checked against the manifest's md5 and size before it is
 * kept (a truncated or corrupted grid would give silently wrong heights).
 * A pack is installed atomically: files land in `<pack>.tmp/` and the
 * directory is renamed only when all of them verified.
 */
import { parsePackIndex, type InstalledGrid, type Pack, type PackIndex } from '@core/convert/packs';
import { Directory, File, Paths } from 'expo-file-system';
import { TILE_HOST } from './basemapTiles';

const ROOT = 'proj-grids';
const INDEX = 'index.json';
const INDEX_URL = `${TILE_HOST}/proj-grids/index.json`;
/** Re-fetch the index at most this often (packs change monthly at most). */
const INDEX_MAX_AGE_MS = 7 * 24 * 3600_000;

function root(): Directory {
  return new Directory(Paths.document, ROOT);
}

/** A plain filesystem path (PROJ wants paths, not file:// URIs). */
export function fsPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, '')).replace(/\/$/, '');
}

export function gridRootPath(): string {
  return fsPath(root().uri);
}

let cachedIndex: { at: number; index: PackIndex } | null = null;

function readCachedIndex(): PackIndex | null {
  try {
    const f = new File(root(), INDEX);
    if (!f.exists) return null;
    return parsePackIndex(JSON.parse(f.textSync()));
  } catch {
    return null;
  }
}

/** The pack index: memory, then disk, then (when allowed) the network. */
export async function packIndex(
  opts: { network: boolean; fetchImpl?: typeof fetch } = { network: true },
): Promise<PackIndex | null> {
  if (cachedIndex && Date.now() - cachedIndex.at < INDEX_MAX_AGE_MS) return cachedIndex.index;
  const disk = readCachedIndex();
  let stale = true;
  try {
    const f = new File(root(), INDEX);
    stale = !f.exists || Date.now() - (f.modificationTime ?? 0) > INDEX_MAX_AGE_MS;
  } catch {
    stale = true;
  }
  if (disk && (!stale || !opts.network)) {
    cachedIndex = { at: Date.now(), index: disk };
    return disk;
  }
  if (!opts.network) return disk;
  try {
    const res = await (opts.fetchImpl ?? fetch)(INDEX_URL);
    if (!res.ok) return disk;
    const text = await res.text();
    const parsed = parsePackIndex(JSON.parse(text));
    if (!parsed) return disk;
    const dir = root();
    if (!dir.exists) dir.create({ intermediates: true });
    const f = new File(dir, INDEX);
    if (f.exists) f.delete();
    f.create();
    f.write(text);
    cachedIndex = { at: Date.now(), index: parsed };
    return parsed;
  } catch {
    return disk;
  }
}

interface LocalManifest {
  id: string;
  name: string;
  files: { name: string; crop: Pack['files'][number]['crop']; md5: string }[];
}

/** Every grid file of every installed pack, with its crop. */
export function installedGrids(): InstalledGrid[] {
  const out: InstalledGrid[] = [];
  try {
    const dir = root();
    if (!dir.exists) return out;
    for (const entry of dir.list()) {
      if (!(entry instanceof Directory) || entry.name.endsWith('.tmp')) continue;
      const mf = new File(entry, 'manifest.json');
      if (!mf.exists) continue;
      const m = JSON.parse(mf.textSync()) as LocalManifest;
      for (const f of m.files) {
        const file = new File(entry, f.name);
        if (file.exists)
          out.push({ pack: m.id, name: f.name, path: fsPath(file.uri), crop: f.crop });
      }
    }
  } catch {
    // A broken pack directory reads as "not installed" (the panel offers it again).
  }
  return out;
}

export function installedPackIds(): string[] {
  return [...new Set(installedGrids().map((g) => g.pack))];
}

export class PackDownloadError extends Error {}

/**
 * Download and verify one pack. `onProgress` gets bytes done / total.
 * Throws PackDownloadError (nothing is left half-installed).
 */
export async function installPack(
  pack: Pack,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const base = root();
  if (!base.exists) base.create({ intermediates: true });
  const tmp = new Directory(base, `${pack.id}.tmp`);
  if (tmp.exists) tmp.delete();
  tmp.create();
  let done = 0;
  try {
    for (const f of pack.files) {
      const dest = new File(tmp, f.name);
      await File.downloadFileAsync(`${TILE_HOST}/proj-grids/${pack.id}/${f.name}`, dest, {
        idempotent: true,
      });
      const info = dest.info({ md5: true });
      if (info.size !== f.bytes || info.md5 !== f.md5) {
        throw new PackDownloadError(`${f.name} failed its checksum`);
      }
      done += f.bytes;
      onProgress?.(done, pack.bytes);
    }
    const manifest: LocalManifest = {
      id: pack.id,
      name: pack.name,
      files: pack.files.map((f) => ({ name: f.name, crop: f.crop, md5: f.md5 })),
    };
    const mf = new File(tmp, 'manifest.json');
    mf.create();
    mf.write(JSON.stringify(manifest));
    const final = new Directory(base, pack.id);
    if (final.exists) final.delete();
    tmp.rename(pack.id);
  } catch (e) {
    try {
      if (tmp.exists) tmp.delete();
    } catch {
      // best effort
    }
    throw e instanceof PackDownloadError ? e : new PackDownloadError((e as Error).message);
  }
}

export function removePack(id: string): void {
  const d = new Directory(root(), id);
  if (d.exists) d.delete();
}

/** For the self-test only: the directory `scripts/convert-native-suite.sh` fills. */
export function selfTestDir(): Directory {
  return new Directory(Paths.document, 'convert-selftest');
}
