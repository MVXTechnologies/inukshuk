/**
 * Settings → Extensions, every extension's entry and install hooks, by key
 * (`ExtensionSettingsModule`). `ExtensionsSection` and the lifecycle actions
 * (`./actions`) iterate this.
 */
import type { ExtensionKey } from '@core/extensions/keys';

import { GEODETIC_SETTINGS } from './geodetic/settings';
import { TIDES_SETTINGS } from './tides/settings';
import type { ExtensionSettingsModule } from './types';

export const EXTENSION_SETTINGS: Record<ExtensionKey, ExtensionSettingsModule> = {
  geodetic: GEODETIC_SETTINGS,
  tides: TIDES_SETTINGS,
};
