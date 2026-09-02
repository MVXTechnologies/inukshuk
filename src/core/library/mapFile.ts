/**
 * What kind of file a library map is backed by.
 *
 * Everything in the library used to be a PDF. It no longer is: a CanMatrix
 * GeoTIFF sheet is far too big to keep, so the import renders its overlay once
 * and stores *that* — a PNG — as the map file (see `@data/geotiffImport`).
 *
 * The stored extension is the discriminator, deliberately. It is a property of
 * the bytes on disk rather than a flag in the index, so it cannot drift out of
 * sync with them, it needs no library-schema migration to introduce, and the
 * export archive already names its entries from it (`@core/export/archivePlan`).
 */

/** Lower-cased extension of a uri's basename (no dot), or null when it has none. */
export function mapFileExtension(uri: string): string | null {
  const base = uri.split(/[?#]/)[0]?.split(/[/\\]/).pop() ?? '';
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(base);
  return match !== null ? (match[1] ?? '').toLowerCase() : null;
}

/**
 * Is this map already a rendered raster overlay — a picture to draw directly,
 * rather than a document to rasterize first?
 */
export function isRenderedRasterMap(uri: string): boolean {
  const ext = mapFileExtension(uri);
  return ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp';
}

/**
 * Does a picked file look like a GeoTIFF, and so want the raster importer?
 *
 * Both signals are checked because neither is reliable on its own: Android file
 * providers report a `.tif` as `application/octet-stream` about as often as
 * `image/tiff`, and a file can arrive with a content:// name that has no
 * extension. Guessing wrong is harmless — the importer verifies the TIFF magic
 * number before it does anything with the bytes.
 */
export function looksLikeGeoTiffFile(file: {
  name?: string | null;
  mimeType?: string | null;
}): boolean {
  if (/\.tiff?$/i.test(file.name ?? '')) return true;
  return file.mimeType === 'image/tiff';
}
