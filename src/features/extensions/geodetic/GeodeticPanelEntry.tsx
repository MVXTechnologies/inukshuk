import { activeFilterCount } from '@core/geodetic/filter';
import { useSettingsStore } from '@state/settingsStore';

import { GeodeticFilterButton } from '../../map/components/GeodeticFilterPanel';
import { GeodeticLegend } from '../../map/components/GeodeticLegend';
import { SwitchRow } from '../../map/components/mapSheet';
import { setExtensionPrefs, useExtensionPrefs } from '../prefs';
import type { ExtensionPanelEntryProps } from '../types';

/** Map overlays › Extensions › Geodetic points: its switch, filter funnel (with badge) and legend. */
export function GeodeticPanelEntry({ onOpenGeodeticFilter }: ExtensionPanelEntryProps) {
  const { show } = useExtensionPrefs('geodetic');
  const geodeticFilter = useSettingsStore((s) => s.geodeticFilter);
  const filterCount = activeFilterCount(geodeticFilter);
  return (
    <SwitchRow
      icon="map-marker-radius-outline"
      label="Geodetic points"
      hint={
        filterCount > 0
          ? `Filtered · ${filterCount} filter${filterCount === 1 ? '' : 's'}`
          : 'Survey marks and benchmarks'
      }
      value={show}
      onToggle={() => setExtensionPrefs('geodetic', { show: !show })}
      accessory={<GeodeticFilterButton onPress={onOpenGeodeticFilter} />}
      below={
        <GeodeticLegend
          disabled={!show}
          types={geodeticFilter.types}
          tidal={geodeticFilter.tidal}
        />
      }
    />
  );
}
