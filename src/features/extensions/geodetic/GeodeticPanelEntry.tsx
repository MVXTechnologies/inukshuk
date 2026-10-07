import { EXTENSIONS } from '@core/extensions/registry';
import { activeFilterCount } from '@core/geodetic/filter';
import { useSettingsStore } from '@state/settingsStore';

import { GeodeticFilterButton } from '../../map/components/GeodeticFilterPanel';
import { SwitchRow } from '../../map/components/mapSheet';
import { setExtensionPrefs, useExtensionPrefs } from '../prefs';
import type { ExtensionPanelEntryProps } from '../types';

/**
 * Map overlays › Extensions › Geodetic points: one row, its switch, its
 * summary (or the active filter count) and its filter funnel. The mark
 * symbols are in the filter page and in Settings › Extensions' details.
 */
export function GeodeticPanelEntry({ onOpenGeodeticFilter }: ExtensionPanelEntryProps) {
  const { show } = useExtensionPrefs('geodetic');
  const geodeticFilter = useSettingsStore((s) => s.geodeticFilter);
  const filterCount = activeFilterCount(geodeticFilter);
  const { label, summary } = EXTENSIONS.geodetic;
  return (
    <SwitchRow
      icon="map-marker-radius-outline"
      label={label}
      hint={
        filterCount > 0
          ? `Filtered · ${filterCount} filter${filterCount === 1 ? '' : 's'}`
          : summary
      }
      value={show}
      onToggle={() => setExtensionPrefs('geodetic', { show: !show })}
      accessory={<GeodeticFilterButton onPress={onOpenGeodeticFilter} />}
    />
  );
}
