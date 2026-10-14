import type { SharePlan } from '@core/library/sharePlan';
import * as storage from '@data/storage';
import * as Sharing from 'expo-sharing';
import { strToU8, Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { Share } from 'react-native';

/**
 * "Send a copy" (#711): build what the {@link SharePlan} says on the phone and
 * hand it to the system share sheet. Nothing is hosted.
 *
 * - A single trail or map is copied into the cache under its readable name
 *   (`Mont Jacques-Cartier.gpx`), never the random id it is stored under.
 * - A zip is streamed like "Download your data": each file is read in slices
 *   through fflate's incremental `Zip` into a cache file, so a 40 MB PDF
 *   never sits whole in memory. PDFs are stored (already compressed), GPX and
 *   text deflated. The staged file is deleted once the sheet closes.
 * - Catalog maps alone go as text (their links), through React Native's
 *   Share, since a link is not a file.
 */

export type SendCopyResult =
  { kind: 'shared' } | { kind: 'unavailable' } | { kind: 'error'; message: string };

const CHUNK_BYTES = 1024 * 1024;

const GPX = { mimeType: 'application/gpx+xml', UTI: 'public.xml' };
const PDF = { mimeType: 'application/pdf', UTI: 'com.adobe.pdf' };
const ZIP = { mimeType: 'application/zip', UTI: 'public.zip-archive' };

/** The bytes the plan sends, before compression (the Share sheet's size). */
export function planBytes(plan: SharePlan): number {
  switch (plan.kind) {
    case 'gpx':
    case 'pdf':
      return storage.fileSizeAt(plan.sourceUri);
    case 'waypoints':
      return strToU8(plan.text).length;
    case 'link':
      return 0;
    case 'zip':
      return (
        plan.files.reduce((sum, f) => sum + storage.fileSizeAt(f.sourceUri), 0) +
        plan.texts.reduce((sum, t) => sum + strToU8(t.text).length, 0)
      );
  }
}

async function shareFile(
  uri: string,
  type: { mimeType: string; UTI: string },
  dialogTitle: string,
): Promise<void> {
  await Sharing.shareAsync(uri, { ...type, dialogTitle });
}

function writeZip(plan: Extract<SharePlan, { kind: 'zip' }>): string {
  const writer = storage.createCacheFileWriter(plan.fileName);
  try {
    let zipError: Error | null = null;
    const zip = new Zip((err, chunk) => {
      if (err) {
        zipError ??= err;
        return;
      }
      if (chunk.length > 0) writer.write(chunk);
    });
    const check = () => {
      if (zipError) throw zipError;
    };
    for (const file of plan.files) {
      // Deleted since the sheet opened: leave it out rather than truncate.
      if (!storage.fileExists(file.sourceUri)) continue;
      const entry =
        file.kind === 'pdf'
          ? new ZipPassThrough(file.path)
          : new ZipDeflate(file.path, { level: 6 });
      zip.add(entry);
      storage.readFileChunks(file.sourceUri, CHUNK_BYTES, (chunk, final) =>
        entry.push(chunk, final),
      );
      check();
    }
    for (const text of plan.texts) {
      const entry = new ZipDeflate(text.path, { level: 6 });
      zip.add(entry);
      entry.push(strToU8(text.text), true);
      check();
    }
    zip.end();
    check();
    writer.close();
    return writer.uri;
  } catch (err) {
    writer.close();
    storage.deleteFileAt(writer.uri);
    throw err;
  }
}

export async function sendCopy(plan: SharePlan, dialogTitle: string): Promise<SendCopyResult> {
  try {
    if (plan.kind === 'link') {
      await Share.share({ message: plan.message, title: dialogTitle });
      return { kind: 'shared' };
    }
    if (!(await Sharing.isAvailableAsync())) return { kind: 'unavailable' };
    if (plan.kind === 'gpx' || plan.kind === 'pdf') {
      const uri = await storage.copyToSharedCache(plan.sourceUri, plan.fileName);
      await shareFile(uri, plan.kind === 'gpx' ? GPX : PDF, dialogTitle);
      return { kind: 'shared' };
    }
    const uri =
      plan.kind === 'zip'
        ? writeZip(plan)
        : (() => {
            const writer = storage.createCacheFileWriter(plan.fileName);
            try {
              writer.write(strToU8(plan.text));
            } finally {
              writer.close();
            }
            return writer.uri;
          })();
    try {
      await shareFile(uri, plan.kind === 'zip' ? ZIP : GPX, dialogTitle);
    } finally {
      // Only needed while the sheet is up: gone whether it was sent or not.
      storage.deleteFileAt(uri);
    }
    return { kind: 'shared' };
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}
