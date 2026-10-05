/**
 * The overlays sheet's tabs (owner, 2026-10-05): Map · Terrain · Sports ·
 * Extensions. Which row lives in which tab is declared here, once, so a
 * caller that wants the sheet open on a row ("open the geodetic filter")
 * asks for the row and gets the right tab. Adding a row (climbing crags will
 * join Sports) is one line in OVERLAY_ROW_TAB.
 */

export type OverlayTab = 'map' | 'terrain' | 'sports' | 'extensions';

export const OVERLAY_TABS: readonly OverlayTab[] = ['map', 'terrain', 'sports', 'extensions'];

/** Full tab names (accessibility labels). */
export const OVERLAY_TAB_LABEL: Record<OverlayTab, string> = {
  map: 'Map',
  terrain: 'Terrain',
  sports: 'Sports',
  extensions: 'Extensions',
};

/** Compact labels for the tab bar (the widest one abbreviated). */
export const OVERLAY_TAB_SHORT: Record<OverlayTab, string> = {
  map: 'Map',
  terrain: 'Terrain',
  sports: 'Sports',
  extensions: 'Ext.',
};

/** Every row the sheet can be asked to open on, and its tab. */
export const OVERLAY_ROW_TAB = {
  content: 'map',
  pdfMaps: 'map',
  parks: 'map',
  satelliteLabels: 'map',
  imagery: 'map',
  shading: 'terrain',
  tiltRelief: 'terrain',
  contours: 'terrain',
  slope: 'terrain',
  peaks: 'terrain',
  seeThroughWhite: 'terrain',
  heatmap: 'sports',
  weather: 'sports',
  marine: 'sports',
  geodetic: 'extensions',
  geodeticFilter: 'extensions',
  tides: 'extensions',
} as const satisfies Record<string, OverlayTab>;

export type OverlayRow = keyof typeof OVERLAY_ROW_TAB;

export function tabForRow(row: OverlayRow): OverlayTab {
  return OVERLAY_ROW_TAB[row];
}

/** A persisted tab, or the first tab for anything else (old or junk settings). */
export function sanitizeOverlayTab(raw: unknown): OverlayTab {
  return OVERLAY_TABS.includes(raw as OverlayTab) ? (raw as OverlayTab) : 'map';
}
