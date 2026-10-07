/**
 * The extensions on the live map, by key (`ExtensionMapModule`): MapScreen's
 * extension host (`./useExtensionMap`) iterates this. Kept apart from
 * `./modules` so Settings and the overlays sheet never load MapLibre's
 * components. An extension with no entry is drawn but has no tap or card.
 */
import type { ExtensionKey } from '@core/extensions/keys';

import { GEODETIC_MAP } from './geodetic/map';
import { TIDES_MAP } from './tides/map';
import type { ExtensionMapModule } from './types';

export const EXTENSION_MAP_MODULES: Partial<Record<ExtensionKey, ExtensionMapModule<unknown>>> = {
  geodetic: GEODETIC_MAP,
  tides: TIDES_MAP,
};
