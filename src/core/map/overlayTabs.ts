/**
 * The overlays sheet's tabs (owner, 2026-10-05): Map · Terrain · Sports ·
 * Extensions. Which row lives in which tab is declared here, once, so a
 * caller that wants the sheet open on a row ("open the geodetic filter")
 * asks for the row and gets the right tab. Adding a row (climbing crags will
 * join Sports) is one line in OVERLAY_ROW_TAB.
 *
 * Sub-panels (#668): an item with options of its own (an extension, the
 * Satellite base map, PDF maps, Weather) opens them as a page of the sheet,
 * with a back row, instead of greyed rows in the tab (the owner's sub-menu
 * rule). Each sub-panel belongs to a tab, the one its back row returns to.
 */
import type { AnyExtensionKey } from '@core/extensions/keys';

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
  pointingLine: 'map',
  seeThroughWhite: 'map',
  basemap: 'terrain',
  satelliteLabels: 'terrain',
  imagery: 'terrain',
  shading: 'terrain',
  tiltRelief: 'terrain',
  contours: 'terrain',
  slope: 'terrain',
  slopeOptions: 'terrain',
  peaks: 'terrain',
  heatmap: 'sports',
  weather: 'sports',
  marine: 'sports',
  geodetic: 'extensions',
  geodeticFilter: 'extensions',
  tides: 'extensions',
  gnss: 'extensions',
  team: 'extensions',
} as const satisfies Record<string, OverlayTab>;

export type OverlayRow = keyof typeof OVERLAY_ROW_TAB;

export function tabForRow(row: OverlayRow): OverlayTab {
  return OVERLAY_ROW_TAB[row];
}

/** The built-in sub-panels (not extensions) and the tab each belongs to. */
export const BUILT_IN_SUB_PANEL_TAB = {
  satellite: 'terrain',
  slope: 'terrain',
  pdfMaps: 'map',
  pointingLine: 'map',
  weather: 'sports',
} as const satisfies Record<string, OverlayTab>;

/** Every sub-panel: a built-in one, or an extension's (in the Extensions tab). */
export type OverlaySubPanel = keyof typeof BUILT_IN_SUB_PANEL_TAB | AnyExtensionKey;

function isBuiltIn(p: OverlaySubPanel): p is keyof typeof BUILT_IN_SUB_PANEL_TAB {
  return Object.prototype.hasOwnProperty.call(BUILT_IN_SUB_PANEL_TAB, p);
}

/** The tab a sub-panel belongs to (the one its back row returns to). */
export function tabForSubPanel(panel: OverlaySubPanel): OverlayTab {
  return isBuiltIn(panel) ? BUILT_IN_SUB_PANEL_TAB[panel] : 'extensions';
}

/**
 * The rows that live inside a sub-panel: asking for one opens its panel.
 * Every other row is in its tab's list.
 */
export const OVERLAY_ROW_PANEL: Partial<Record<OverlayRow, OverlaySubPanel>> = {
  seeThroughWhite: 'pdfMaps',
  satelliteLabels: 'satellite',
  imagery: 'satellite',
  // The slope's steepness, altitude and aspect (#723; the map's legend chip opens it).
  slopeOptions: 'slope',
  geodeticFilter: 'geodetic',
};

/** The sub-panel a row lives in, or null for a row in its tab's list. */
export function panelForRow(row: OverlayRow): OverlaySubPanel | null {
  return OVERLAY_ROW_PANEL[row] ?? null;
}

/** A persisted tab, or the first tab for anything else (old or junk settings). */
export function sanitizeOverlayTab(raw: unknown): OverlayTab {
  return OVERLAY_TABS.includes(raw as OverlayTab) ? (raw as OverlayTab) : 'map';
}
