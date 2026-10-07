/**
 * Tide stations in Settings → Extensions (`@core/extensions/descriptors/tides`
 * is the pure half). Installing needs no hook: Canada's stations load live
 * from CHS once it is drawn (`./map`), and the station tiles ride in new
 * offline regions. Removing keeps the device's CHS copy (a few hundred kB),
 * so a reinstall works offline at once.
 */
import type { ExtensionSettingsModule } from '../types';
import { TideSettings } from './TideSettings';

export const TIDES_SETTINGS: ExtensionSettingsModule = {
  Settings: TideSettings,
};
