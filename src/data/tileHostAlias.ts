import { tileHostAlias } from '@core/map/tileUrls';
import { TransformRequestManager } from '@maplibre/maplibre-react-native';

import { TILE_HOST, TILE_KEY_HOST } from './basemapTiles';

/**
 * Route MapLibre's requests for the frozen template host ({@link TILE_KEY_HOST})
 * to wherever the Worker really lives ({@link TILE_HOST}). The rewrite happens
 * in MapLibre's HTTP layer, after the offline database lookup, which keeps
 * using the template URL: downloaded regions survive a host move untouched.
 *
 * A no-op while the two hosts are the same (today), so it touches no native
 * module until the move. Call it once at startup, before any map mounts.
 * Returns whether an alias was installed.
 */
export function installTileHostAlias(
  keyHost: string = TILE_KEY_HOST,
  servingHost: string = TILE_HOST,
): boolean {
  const alias = tileHostAlias(keyHost, servingHost);
  if (alias === null) return false;
  TransformRequestManager.addUrlTransform(alias);
  return true;
}
