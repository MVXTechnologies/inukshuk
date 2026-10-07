/**
 * External GNSS receiver in Settings → Extensions
 * (`@core/extensions/descriptors/gnss` is the pure half). Installing needs no
 * hook: the receiver connects once one is paired (`@features/gnss/GnssHost`).
 * Removing disconnects it, forgets it and deletes the caster passwords; the
 * correction profiles and the project datum are kept for a reinstall.
 */
import { gnssSecrets } from '@data/gnss/credentials';
import { gnssSession } from '@features/gnss/session';
import { useGnssStore } from '@state/gnssStore';

import type { ExtensionSettingsModule } from '../types';
import { GnssSettings } from './GnssSettings';

export async function removeGnss(): Promise<void> {
  gnssSession()?.stop();
  const store = useGnssStore.getState();
  await store.hydrate();
  store.updateConfig({ receiver: null, activeProfileId: null });
  await gnssSecrets.clear();
}

export const GNSS_SETTINGS: ExtensionSettingsModule = {
  Settings: GnssSettings,
  onRemove: removeGnss,
};
