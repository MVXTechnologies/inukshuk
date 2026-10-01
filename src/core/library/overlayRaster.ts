import { fnv1a32 } from '@core/encoding/fnv1a';
import type { WhiteKeyLevel } from '@core/geo/pdfWhiteKey';
import type { MapDocument } from '@core/models';

/**
 * Identity of a PDF page's overlay raster — shared by the map's overlay hook
 * (which reads it) and the import-time pre-render worker (which writes it,
 * #272 step 2). Both must name the same file for the same page, or the map
 * renders a page the worker already drew. Kept here, pure, so the two can
 * never disagree.
 */

/**
 * Target raster width in CSS px for a whole-page overview. Matches the
 * rasterizer's own default; passed explicitly everywhere so the cache key
 * always names the width the PNG was rendered at.
 */
export const OVERLAY_TARGET_WIDTH_PX = 2048;

/**
 * A document's raster revision: changes whenever the PDF behind a library
 * entry is replaced (re-import, store update), so a stale PNG can never be
 * shown for new bytes. Imported PDFs have unique filenames; the container
 * prefix is ignored because it rotates on iOS without changing the document.
 */
export function documentRevision(map: Pick<MapDocument, 'importedAt' | 'fileUri'>): string {
  return `${map.importedAt}_${fnv1a32(map.fileUri.slice(map.fileUri.lastIndexOf('/') + 1))}`;
}

/**
 * The part of a raster's identity that says how it was drawn beyond the page
 * itself: empty for the plain render (so every raster cached before
 * "See-through white" existed keeps its name), `_wk-<percent>` (`_wk-25` … `_wk-100`) when its white
 * paper was keyed. Switching the level therefore renders each page once per
 * level and then finds it on disk; nothing is ever re-downloaded.
 */
export function rasterLookSuffix(whiteKey: WhiteKeyLevel = 0): string {
  return whiteKey === 0 ? '' : `_wk-${whiteKey * 25}`;
}

/** In-memory cache key of a page's overview raster. */
export function rasterCacheKey(
  docId: string,
  pageIndex: number,
  revision: string,
  whiteKey: WhiteKeyLevel = 0,
): string {
  return `${docId}:${revision}:${pageIndex}:${OVERLAY_TARGET_WIDTH_PX}${rasterLookSuffix(whiteKey)}`;
}

/** The on-disk name of a page's overview raster (without extension). */
export function rasterFileName(
  docId: string,
  pageIndex: number,
  revision: string,
  whiteKey: WhiteKeyLevel = 0,
): string {
  return `${docId}_${revision}_${pageIndex}_${OVERLAY_TARGET_WIDTH_PX}${rasterLookSuffix(whiteKey)}`;
}
