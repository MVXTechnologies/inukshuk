/**
 * Settings → Photos (#587): the user's choices about trail photos, and the
 * rules that turn them into what the map shows. Pure, so the store's
 * hydration and the map layers agree on one definition.
 */

/** "Photo circles appear": in the trail view only, from a zoom, or at every zoom. */
export type PhotoCirclesAppear = 'trail' | 'zoomed' | 'always';

/** "Copies kept": the 2048 px optimized copy (default) or the stripped original. */
export type PhotoCopySize = 'optimized' | 'full';

export const PHOTO_CIRCLES_APPEAR: readonly PhotoCirclesAppear[] = ['trail', 'zoomed', 'always'];
export const PHOTO_COPY_SIZES: readonly PhotoCopySize[] = ['optimized', 'full'];

export const DEFAULT_PHOTO_CIRCLES_APPEAR: PhotoCirclesAppear = 'zoomed';
export const DEFAULT_PHOTO_COPY_SIZE: PhotoCopySize = 'optimized';

/** The main map's "zoomed in" threshold (owner Q2: z12, stacks then circles). */
export const MAIN_MAP_PHOTO_MIN_ZOOM = 12;

export function isPhotoCirclesAppear(v: unknown): v is PhotoCirclesAppear {
  return PHOTO_CIRCLES_APPEAR.includes(v as PhotoCirclesAppear);
}

export function isPhotoCopySize(v: unknown): v is PhotoCopySize {
  return PHOTO_COPY_SIZES.includes(v as PhotoCopySize);
}

/**
 * The main map's photo layer: off, or the zoom it starts at. Photos show only
 * for trails the user shows on the map; this decides whether and from where.
 */
export function mainMapPhotoMinZoom(
  photosOnMainMap: boolean,
  appear: PhotoCirclesAppear,
): number | null {
  if (!photosOnMainMap || appear === 'trail') return null;
  return appear === 'always' ? 0 : MAIN_MAP_PHOTO_MIN_ZOOM;
}
