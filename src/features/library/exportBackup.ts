import { backupZipName, planBackup } from '@core/library/backup';
import type { TrackSummary } from '@core/models';
import * as storage from '@data/storage';
import * as Sharing from 'expo-sharing';
import { strToU8, zipSync, type Zippable } from 'fflate';

export type ExportBackupResult =
  | { kind: 'exported'; tracks: number; photos: number }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

/**
 * Bundle the library into a ZIP and hand it to the share sheet: `library.json`
 * (the persisted index, verbatim), every trail's GPX and every note photo.
 * Maps (PDFs) are NOT included — they can run to hundreds of MB and the zip is
 * assembled in memory; re-import them from their source instead.
 *
 * The archive is staged in the cache and deleted once the share sheet resolves.
 */
export async function exportLibraryBackup(
  tracks: readonly TrackSummary[],
  /** In-memory index snapshot, packed only if `library.json` was never written. */
  fallbackIndex: unknown,
): Promise<ExportBackupResult> {
  try {
    if (!(await Sharing.isAvailableAsync())) return { kind: 'unavailable' };

    const indexText = (await storage.readIndexText()) ?? JSON.stringify(fallbackIndex);
    const zippable: Zippable = { 'library.json': [strToU8(indexText), { level: 6 }] };

    // Count what actually lands in the archive; a missing/unreadable file is
    // skipped (the index still records it) rather than failing the whole backup.
    let trackCount = 0;
    let photoCount = 0;
    for (const entry of planBackup(tracks).entries) {
      try {
        zippable[entry.zipPath] = [
          await storage.readFileBytes(entry.sourceUri),
          { level: entry.deflate ? 6 : 0 },
        ];
        if (entry.kind === 'gpx') trackCount++;
        else photoCount++;
      } catch {
        // Skip files that no longer exist on disk.
      }
    }

    const uri = storage.writeCacheBytes(backupZipName(new Date()), zipSync(zippable));
    try {
      await Sharing.shareAsync(uri, {
        mimeType: 'application/zip',
        UTI: 'public.zip-archive',
        dialogTitle: 'Inukshuk backup — trails, notes & photos (maps not included)',
      });
    } finally {
      storage.deleteFileAt(uri); // the staged zip is only needed for the share sheet
    }
    return { kind: 'exported', tracks: trackCount, photos: photoCount };
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}
