import { unzipSync } from 'fflate';

/**
 * Extract the map PDF from a downloaded catalog file. CanTopo GeoPDFs are
 * served as small zips containing the PDF (plus occasional metadata files);
 * some servers hand back the bare PDF despite the .zip name. Pure — safe for
 * unit tests and the generator alike. Returns null when no PDF can be found
 * (corrupt archive, wrong content) — never throws.
 */

/** Does the buffer start with the %PDF magic? */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 // F
  );
}

/**
 * The PDF inside `bytes`: the bytes themselves when they already are a PDF,
 * else the largest `.pdf` entry of the zip (largest, so a bundled readme or
 * legend PDF can never shadow the map sheet). Null when neither works.
 */
export function extractPdf(bytes: Uint8Array): Uint8Array | null {
  if (looksLikePdf(bytes)) return bytes;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (file) => /\.pdf$/i.test(file.name) && !file.name.startsWith('__MACOSX/'),
    });
  } catch {
    return null;
  }
  let best: Uint8Array | null = null;
  for (const data of Object.values(entries)) {
    if (best === null || data.length > best.length) best = data;
  }
  return best !== null && looksLikePdf(best) ? best : null;
}

/**
 * The largest zip a catalog download may unpack in memory. Catalog zips are
 * CanTopo sheets, 16 MB at most (2026-10); `unzipSync` needs the archive and
 * the extracted PDF in memory at once, so a much larger zip is refused with a
 * message rather than risking the OOM #345 describes.
 */
export const MAX_CATALOG_ZIP_BYTES = 64 * 1024 * 1024;

/**
 * What to do with a finished catalog download, from its first bytes and size
 * (#345). A bare PDF (every US Topo / USFS sheet, up to 220 MB) is moved into
 * place as is, never read into memory. Anything else is a zip to unpack, if
 * it is small enough.
 */
export type CatalogPayloadPlan =
  { kind: 'move-pdf' } | { kind: 'unzip' } | { kind: 'refuse'; reason: string };

export function planCatalogPayload(head: Uint8Array, sizeBytes: number): CatalogPayloadPlan {
  if (looksLikePdf(head)) return { kind: 'move-pdf' };
  if (sizeBytes > MAX_CATALOG_ZIP_BYTES) {
    const mb = Math.round(sizeBytes / (1024 * 1024));
    return { kind: 'refuse', reason: `The downloaded archive is too large to unpack (${mb} MB).` };
  }
  return { kind: 'unzip' };
}
