/**
 * Map overlays › Extensions, every extension's row (switch, legend…) by key.
 * `ExtensionsPanel` lists the installed ones in registry order.
 */
import type { ExtensionKey } from '@core/extensions/keys';
import type { ComponentType } from 'react';

import { GeodeticPanelEntry } from './geodetic/GeodeticPanelEntry';
import { TidePanelEntry } from './tides/TidePanelEntry';
import type { ExtensionPanelEntryProps } from './types';

export const EXTENSION_PANEL_ENTRIES: Record<
  ExtensionKey,
  ComponentType<ExtensionPanelEntryProps>
> = {
  geodetic: GeodeticPanelEntry,
  tides: TidePanelEntry,
};
