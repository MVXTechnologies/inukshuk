/**
 * Map overlays › Extensions, every extension's row and sub-panel by key
 * (`ExtensionPanelModule`): map extensions AND device extensions, so each
 * installed one has its one-liner and its page (a test fails when a
 * registered extension has none). `ExtensionsPanel` lists the installed rows
 * in registry order; `OverlaysPanel` opens a sub-panel by key.
 */
import type { AnyExtensionKey } from '@core/extensions/keys';

import { GeodeticPanelEntry } from './geodetic/GeodeticPanelEntry';
import { GeodeticSubPanel } from './geodetic/GeodeticSubPanel';
import { GnssPanelEntry } from './gnss/GnssPanelEntry';
import { GnssSubPanel } from './gnss/GnssSubPanel';
import { TeamPanelEntry } from './team/TeamPanelEntry';
import { TeamSubPanel } from './team/TeamSubPanel';
import { TidePanelEntry } from './tides/TidePanelEntry';
import { TideSubPanel } from './tides/TideSubPanel';
import type { ExtensionPanelModule } from './types';

export const EXTENSION_PANELS: Record<AnyExtensionKey, ExtensionPanelModule> = {
  geodetic: { Entry: GeodeticPanelEntry, Panel: GeodeticSubPanel },
  tides: { Entry: TidePanelEntry, Panel: TideSubPanel },
  gnss: { Entry: GnssPanelEntry, Panel: GnssSubPanel },
  team: { Entry: TeamPanelEntry, Panel: TeamSubPanel },
};
