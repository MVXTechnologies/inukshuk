import { EXTENSIONS } from '@core/extensions/registry';
import { activeFilterCount } from '@core/geodetic/filter';
import { useSettingsStore } from '@state/settingsStore';

import { SubPanelButton, SwitchRow } from '../../map/components/mapSheet';
import { setExtensionPrefs, useExtensionPrefs } from '../prefs';
import type { ExtensionPanelEntryProps } from '../types';
import { GEODETIC_ICON } from './icon';

/** The row's line under its name: the active filter count, else the summary. */
export function geodeticHint(filterCount: number, summary: string): string {
  return filterCount > 0
    ? `Filtered · ${filterCount} filter${filterCount === 1 ? '' : 's'}`
    : summary;
}

/**
 * Map overlays › Extensions › Geodetic points: one row, its switch, its
 * summary (or the active filter count) and the sub-panel accessory, badged
 * with that count. The filters are in its sub-panel (`GeodeticSubPanel`).
 */
export function GeodeticPanelEntry({ onOpenPanel }: ExtensionPanelEntryProps) {
  const { show } = useExtensionPrefs('geodetic');
  const filterCount = useSettingsStore((s) => activeFilterCount(s.geodeticFilter));
  const { label, summary } = EXTENSIONS.geodetic;
  return (
    <SwitchRow
      icon={GEODETIC_ICON}
      label={label}
      hint={geodeticHint(filterCount, summary)}
      value={show}
      onToggle={() => setExtensionPrefs('geodetic', { show: !show })}
      accessory={
        <SubPanelButton
          onPress={onOpenPanel}
          badge={filterCount}
          accessibilityLabel={
            filterCount > 0
              ? `Options for ${label}, ${filterCount} filter${filterCount === 1 ? '' : 's'} on`
              : `Options for ${label}`
          }
        />
      }
    />
  );
}
