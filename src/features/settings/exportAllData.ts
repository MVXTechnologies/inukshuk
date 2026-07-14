import { dataArchiveName, type ArchivePlan } from '@core/export/archivePlan';
import * as storage from '@data/storage';
import * as Sharing from 'expo-sharing';
import { strToU8, Zip, ZipDeflate, ZipPassThrough } from 'fflate';

export type ExportAllDataResult =
  | { kind: 'exported'; files: number }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

/** Slice size for streaming file bytes into the zip (bounds peak memory). */
const CHUNK_BYTES = 1024 * 1024;

/** Let React commit a progress update before the next synchronous zip slice. */
const yieldToUi = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Build the "Download your data" ZIP from a {@link ArchivePlan} and hand it to
 * the share sheet: `library.json` (the persisted index, verbatim) at the root
 * plus every planned map/GPX/photo under its Library-mirroring path.
 *
 * Unlike the Library's backup (which assembles the whole archive in memory and
 * therefore excludes maps), this streams: each source file is read in
 * {@link CHUNK_BYTES} slices, pushed through fflate's incremental `Zip`, and
 * the compressed output is appended straight to a cache file — peak memory
 * stays around one chunk regardless of how many tens of MB a PDF weighs.
 *
 * A source file that vanished since planning is skipped (the index still
 * records it); the archive is staged in the cache and deleted once the share
 * sheet resolves. `onProgress(done, total)` ticks once per planned file.
 */
export async function exportAllData(
  plan: ArchivePlan,
  /** In-memory index snapshot, packed only if `library.json` was never written. */
  fallbackIndex: unknown,
  onProgress?: (done: number, total: number) => void,
): Promise<ExportAllDataResult> {
  let writer: storage.CacheFileWriter | null = null;
  try {
    if (!(await Sharing.isAvailableAsync())) return { kind: 'unavailable' };

    writer = storage.createCacheFileWriter(dataArchiveName(new Date()));
    const sink = writer;
    let zipError: Error | null = null;
    const zip = new Zip((err, chunk) => {
      if (err) {
        zipError ??= err;
        return;
      }
      try {
        if (chunk.length > 0) sink.write(chunk);
      } catch (e) {
        zipError ??= e instanceof Error ? e : new Error(String(e));
      }
    });
    // fflate reports failures through the callback; surface them as throws.
    const checkZip = () => {
      if (zipError) throw zipError;
    };

    const indexText = (await storage.readIndexText()) ?? JSON.stringify(fallbackIndex);
    const indexEntry = new ZipDeflate('library.json', { level: 6 });
    zip.add(indexEntry);
    indexEntry.push(strToU8(indexText), true);
    checkZip();

    let files = 1; // library.json
    const total = plan.entries.length;
    for (let i = 0; i < total; i++) {
      const entry = plan.entries[i]!;
      onProgress?.(i, total);
      await yieldToUi();
      // Deleted since planning? Skip — must be checked before the entry header
      // is written, or the archive would be left with a truncated member.
      if (!storage.fileExists(entry.sourceUri)) continue;
      const stream = entry.deflate
        ? new ZipDeflate(entry.zipPath, { level: 6 })
        : new ZipPassThrough(entry.zipPath);
      zip.add(stream);
      storage.readFileChunks(entry.sourceUri, CHUNK_BYTES, (chunk, final) =>
        stream.push(chunk, final),
      );
      checkZip();
      files++;
    }
    onProgress?.(total, total);

    zip.end();
    checkZip();
    writer.close();

    try {
      await Sharing.shareAsync(writer.uri, {
        mimeType: 'application/zip',
        UTI: 'public.zip-archive',
        dialogTitle: 'Inukshuk — your data (maps, trails, notes & photos)',
      });
    } finally {
      storage.deleteFileAt(writer.uri); // the staged zip is only needed for the share sheet
    }
    return { kind: 'exported', files };
  } catch (e) {
    if (writer) {
      // Never leave a half-written archive behind in the cache.
      try {
        writer.close();
        storage.deleteFileAt(writer.uri);
      } catch {
        /* cleanup is best-effort */
      }
    }
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}
