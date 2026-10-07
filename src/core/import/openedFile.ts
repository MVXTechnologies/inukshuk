import { sniffActivityFormat, type ActivityFileFormat } from '@core/geo/activityFiles';

/**
 * What a file handed to the app ("Open with Inukshuk", a share) is, judged
 * from its first bytes (#246). A `content://` uri often carries no file name,
 * so the content decides; the name is only a fallback.
 *
 * PDFs are maps; everything else is an activity file (GPX, FIT, TCX, and
 * their gzip / zip archives) or `unknown`, which the GPX path still tries.
 */
export type OpenedFileFormat = 'pdf' | ActivityFileFormat;

/** How far into a file a PDF header may sit (readers tolerate leading junk). */
const PDF_HEADER_WINDOW = 1024;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

/** True when `bytes` carries the `%PDF-` header within the first kilobyte. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const last = Math.min(bytes.length, PDF_HEADER_WINDOW) - PDF_MAGIC.length;
  outer: for (let i = 0; i <= last; i++) {
    for (let j = 0; j < PDF_MAGIC.length; j++) {
      if (bytes[i + j] !== PDF_MAGIC[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** Classify an opened file by content, then by name (`name` may be a uri). */
export function sniffOpenedFile(bytes: Uint8Array, name?: string): OpenedFileFormat {
  if (looksLikePdf(bytes)) return 'pdf';
  const format = sniffActivityFormat(bytes, name);
  if (format !== 'unknown') return format;
  return /\.pdf$/i.test(name ?? '') ? 'pdf' : 'unknown';
}

/** The name a map gets when its uri names no PDF file (most Android content uris). */
export const FALLBACK_MAP_NAME = 'Imported map';

/**
 * A map name from an opened uri: its last path segment, decoded, without a
 * `.pdf` extension (`…/Inbox/Mont%20Tremblant.pdf` → "Mont Tremblant"; an
 * Android document id `primary:Download/Sheet 21L.pdf` → "Sheet 21L"). A uri
 * that names no PDF file (`content://media/external/downloads/1000000094`)
 * gets `fallback`.
 */
export function mapNameFromUri(uri: string, fallback = FALLBACK_MAP_NAME): string {
  const path = uri.split(/[?#]/)[0] ?? '';
  let segment = path.slice(path.lastIndexOf('/') + 1);
  try {
    segment = decodeURIComponent(segment);
  } catch {
    // A malformed escape: keep the raw segment.
  }
  // Document ids put the whole path in one segment, behind a storage volume
  // ("primary:Download/x.pdf", "1A2B-3C4D:x.pdf").
  segment = segment
    .slice(segment.lastIndexOf('/') + 1)
    .replace(/^(primary|home|[0-9A-F]{4}-[0-9A-F]{4}):/i, '');
  const name = /^(.+)\.pdf$/i.exec(segment.trim())?.[1]?.trim();
  return name ? name : fallback;
}
