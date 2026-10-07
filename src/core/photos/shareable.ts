import { stripJpegMetadata } from './jpegStrip';

/**
 * The last gate before a photo leaves the phone (#587): a "Trail + photos"
 * zip, or one photo shared from the viewer.
 *
 * The copies Inukshuk keeps should already carry no location (canvas
 * re-encodes, or "Full size" originals run through `stripJpegMetadata`), but
 * sharing checks again rather than trusting how a file was made: a copy from
 * an older build, a bug, or a file restored from a backup must not leak GPS.
 *
 * Stripping is idempotent on a clean file (a lone orientation APP1 is removed
 * and written back identically), so "clean" means "stripping changes
 * nothing".
 */
export type ShareableJpeg =
  /** Already clean: share the file as it is. */
  | { kind: 'clean' }
  /** Had metadata: share these stripped bytes instead. */
  | { kind: 'stripped'; bytes: Uint8Array; removed: number }
  /** Not a JPEG we can parse: never shared (its metadata cannot be checked). */
  | { kind: 'unreadable' };

export function shareableJpeg(bytes: Uint8Array): ShareableJpeg {
  const stripped = stripJpegMetadata(bytes);
  if (!stripped.jpeg) return { kind: 'unreadable' };
  if (sameBytes(stripped.bytes, bytes)) return { kind: 'clean' };
  return { kind: 'stripped', bytes: stripped.bytes, removed: stripped.removed };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
