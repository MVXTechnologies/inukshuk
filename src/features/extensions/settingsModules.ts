/**
 * Settings → Extensions, every extension's entry and install hooks, by key
 * (`ExtensionSettingsModule`). `ExtensionsSection` and the lifecycle actions
 * (`./actions`) iterate this.
 */
import type { AnyExtensionKey } from '@core/extensions/keys';

import { GEODETIC_SETTINGS } from './geodetic/settings';
import { GNSS_SETTINGS } from './gnss/settings';
import { TIDES_SETTINGS } from './tides/settings';
import { TEAM_SETTINGS } from '@features/team/settings';
import type { ExtensionSettingsModule } from './types';

export const EXTENSION_SETTINGS: Record<AnyExtensionKey, ExtensionSettingsModule> = {
  geodetic: GEODETIC_SETTINGS,
  tides: TIDES_SETTINGS,
  gnss: GNSS_SETTINGS,
  team: TEAM_SETTINGS,
};
