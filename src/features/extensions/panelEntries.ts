/**
 * Map overlays › Extensions, every extension's row (switch, hint, legend…) by
 * key: map extensions AND device extensions, so each installed one has its
 * one-liner (a test fails when a registered extension has none).
 * `ExtensionsPanel` lists the installed ones in registry order.
 */
import type { AnyExtensionKey } from '@core/extensions/keys';
import type { ComponentType } from 'react';

import { GeodeticPanelEntry } from './geodetic/GeodeticPanelEntry';
import { GnssPanelEntry } from './gnss/GnssPanelEntry';
import { TeamPanelEntry } from './team/TeamPanelEntry';
import { TidePanelEntry } from './tides/TidePanelEntry';
import type { ExtensionPanelEntryProps } from './types';

export const EXTENSION_PANEL_ENTRIES: Record<
  AnyExtensionKey,
  ComponentType<ExtensionPanelEntryProps>
> = {
  geodetic: GeodeticPanelEntry,
  tides: TidePanelEntry,
  gnss: GnssPanelEntry,
  team: TeamPanelEntry,
};
