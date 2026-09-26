/**
 * The basemaps a made map can print, and — the point of this module — the
 * matching tile template the LIVE map must show while the editor is open.
 *
 * Before #349 these two disagreed silently: the composer prints Esri's
 * World Street Map for basemap `map`, while the 2D map renders whatever
 * `settings.tileUrl` points at (OpenStreetMap by default). So the editor's
 * "what you see is what prints" promise was false for every style except
 * satellite, where both happen to be Esri World Imagery. Pairing them here
 * means a style can never again be added to one side only.
 *
 * `{z}/{y}/{x}` is not a typo: Esri's REST tile path is row-before-column.
 */

import { NATIVE_MAX_ZOOM, type Basemap } from '@core/geo/tiles';

/** The drape sources the composer can stitch (see `features/map/dem`). */
export type PrintDrapeSource = Exclude<Basemap, 'relief'>;

export type PrintStyleId = 'street' | 'imagery';

export interface PrintStyle {
  id: PrintStyleId;
  /** Shown on the style chip. */
  label: string;
  /** What the composer stitches into the PDF. */
  drape: PrintDrapeSource;
  /** Raster template the live map shows so the preview matches the print. */
  tileUrl: string;
  /** Credit line for the printed footer. */
  attribution: string;
}

/** Deepest zoom this style's service actually serves real tiles at. */
export function styleMaxSourceZoom(style: PrintStyle): number {
  return NATIVE_MAX_ZOOM[style.drape];
}

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';

export const PRINT_STYLES: readonly PrintStyle[] = [
  {
    id: 'street',
    label: 'Street',
    drape: 'map',
    tileUrl: `${ESRI}/World_Street_Map/MapServer/tile/{z}/{y}/{x}`,
    attribution: 'Map © Esri',
  },
  {
    id: 'imagery',
    label: 'Imagery',
    drape: 'satellite',
    tileUrl: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`,
    attribution: 'Imagery © Esri',
  },
] as const;

export const DEFAULT_PRINT_STYLE: PrintStyleId = 'street';

/**
 * Tile size the editor DECLARES for its base raster, in points (#349).
 *
 * Zoom is defined against a 512-point canonical tile, so declaring 128 makes
 * MapLibre fetch two levels deeper than the camera instead of one — four times
 * the tiles, four times the pixels. The default 256 is right for a 1x screen
 * and visibly soft on a 3x one, because MapLibre does not raise raster tile
 * zoom for device pixel ratio (only vector), so a 256-point tile is stretched
 * across ~768 device pixels and the baked-in labels blur.
 *
 * 128 rather than 64: it lands imagery exactly on its native maximum (z17)
 * instead of past it, and 64 would be sixteen times the tiles for detail two
 * of the five sources do not have.
 */
export const EDITOR_RASTER_TILE_SIZE = 128;

export function printStyleById(id: PrintStyleId): PrintStyle {
  return PRINT_STYLES.find((s) => s.id === id) ?? PRINT_STYLES[0]!;
}
