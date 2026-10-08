/**
 * Team mode in Settings → Extensions (`@core/extensions/descriptors/team` is
 * the pure half). Installing needs no hook (`TeamHost` wires the store once
 * installed). Removing stops the mesh; the teams stay on the phone (leaving a
 * team is its own, explicit action).
 */
import { teamService } from '@state/teamStore';

import type { ExtensionSettingsModule } from '@features/extensions/types';

import { TeamSettings } from './TeamSettings';

export const TEAM_SETTINGS: ExtensionSettingsModule = {
  Settings: TeamSettings,
  onRemove: async () => {
    await teamService()?.cancelJoin();
    await teamService()?.deactivate();
  },
};
