import type { Basemap, PackFormat } from '@core/geo/tiles';
import { geodeticTilesUrl, tideTilesUrl, vectorBasemapOption } from '@data/basemapTiles';
import { useSettingsStore } from '@state/settingsStore';

import { buildOsmStyle } from './mapStyle';

/**
 * Which extensions' tiles a pack style carries: those the settings say ride
 * along (`'settings'`, what a download uses), or every published one
 * (`'all'`, the full set of templates a pack of this kind could hold today —
 * what the offline-maps health check compares a pack's record with).
 */
export type PackExtensions = 'settings' | 'all';

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
  // The geodetic-points extension, when installed with "Offline in your
  // regions" on: its tiles ride in every new pack (a pack stores every source
  // of its style). Regions from before the install get a companion pack.
  // Tide stations ride along too (a few KB: the archive stops at z10), so the
  // overlay works offline in every region downloaded from now on.
  // Only once the Tide stations extension is installed.
  const all = extensions === 'all';
  const tideTiles = all || useSettingsStore.getState().tidesInstalledAt > 0 ? tideTilesUrl() : null;
  const geodeticTiles = all ? geodeticTilesUrl() : null;
  const geodetic = {
    ...(all
      ? geodeticTiles !== null
        ? { geodetic: { tiles: geodeticTiles, dark: false } }
        : {}
      : geodeticPackOption()),
    ...(tideTiles !== null ? { tides: { tiles: tideTiles, dark: false } } : {}),
  };
  if (format !== 'vector') return buildOsmStyle(tileUrl, basemap, false, geodetic);
  // Packs always keep the contours, so they work offline whichever way the
  // Contours toggle is set later.
  return buildOsmStyle(tileUrl, basemap, false, {
    vectorBasemap: vectorBasemapOption(false, true),
    ...geodetic,
  });
}

/** `{ geodetic }` for a pack style when the extension wants its marks offline, else `{}`. */
export function geodeticPackOption(): { geodetic?: { tiles: string; dark: boolean } } {
  const s = useSettingsStore.getState();
  const tiles = geodeticTilesUrl();
  return tiles !== null && s.geodeticInstalledAt > 0 && s.geodeticOffline
    ? { geodetic: { tiles, dark: false } }
    : {};
}
