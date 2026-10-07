import type { Basemap, PackFormat } from '@core/geo/tiles';
import type { ExtensionStyleOptions } from '@core/extensions/registry';
import { packExtensions } from '@core/extensions/state';
import { vectorBasemapOption } from '@data/basemapTiles';
import { extensionTilesUrl } from '@features/extensions/availability';
import { extensionsState } from '@features/extensions/prefs';

import { buildOsmStyle } from './mapStyle';

/**
 * Which extensions' tiles a pack style carries: those the settings say ride
 * along (`'settings'`, what a download uses), every published one (`'all'`,
 * the full set of templates a pack of this kind could hold today — what the
 * offline-maps health check compares a pack's record with), or none
 * (`'none'`, the base layer alone — what a legacy pack is stamped with, as
 * nothing says which extensions it holds). Each extension's own policy is
 * its descriptor's `offline.packs` (`@core/extensions/state` packExtensions).
 */
export type PackExtensions = 'settings' | 'all' | 'none';

/**
 * The style a pack downloads through: MapLibre stores every tile and glyph
 * range the style references inside the box. A vector `map` pack therefore
 * references our vector tiles (and glyphs), not the OSM raster.
 */
export function packStyle(
  tileUrl: string,
  basemap: Basemap,
  format: PackFormat,
  extensions: PackExtensions = 'settings',
) {
  // Every extension that rides along: its tiles go in the pack (a pack stores
  // every source of its style). Regions from before an install get a
  // companion pack instead (`@features/extensions/companions`).
  const extensionOptions = packExtensionOptions(extensions);
  if (format !== 'vector') return buildOsmStyle(tileUrl, basemap, false, extensionOptions);
  // Packs always keep the contours, so they work offline whichever way the
  // Contours toggle is set later.
  return buildOsmStyle(tileUrl, basemap, false, {
    vectorBasemap: vectorBasemapOption(false, true),
    ...extensionOptions,
  });
}

/** `{ geodetic?, tides? }` for a pack style: the riding extensions' tiles, light theme. */
export function packExtensionOptions(
  extensions: PackExtensions = 'settings',
): ExtensionStyleOptions {
  const out: ExtensionStyleOptions = {};
  for (const key of packExtensions(extensionsState(), extensions)) {
    const tiles = extensionTilesUrl(key);
    if (tiles !== null) out[key] = { tiles, dark: false };
  }
  return out;
}
