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

import type { Basemap } from '@core/geo/tiles';

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

export function printStyleById(id: PrintStyleId): PrintStyle {
  return PRINT_STYLES.find((s) => s.id === id) ?? PRINT_STYLES[0]!;
}
