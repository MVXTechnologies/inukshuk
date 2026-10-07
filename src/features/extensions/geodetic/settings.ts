/**
 * Geodetic points in Settings → Extensions (`@core/extensions/descriptors/geodetic`
 * is the pure half): its entry and the install hooks (coverage, companion
 * packs). Its overlays row: `./GeodeticPanelEntry`; its map card: `./map`.
 */
import { refreshGeodeticCoverage } from '@data/geodeticCoverage';

import { dropCompanions, syncCompanions } from '../companions';
import { extensionPrefs } from '../prefs';
import type { ExtensionSettingsModule } from '../types';
import { GeodeticSettings } from './GeodeticSettings';

export const GEODETIC_SETTINGS: ExtensionSettingsModule = {
  Settings: GeodeticSettings,
  onInstall() {
    void refreshGeodeticCoverage();
    if (extensionPrefs('geodetic').offline) void syncCompanions('geodetic');
  },
  onRemove: () => dropCompanions('geodetic'),
  async onOfflineChange(on) {
    if (on) await syncCompanions('geodetic');
    else await dropCompanions('geodetic');
  },
};
