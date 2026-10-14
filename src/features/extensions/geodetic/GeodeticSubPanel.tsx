import { EXTENSIONS } from '@core/extensions/registry';
import { activeFilterCount } from '@core/geodetic/filter';
import { useSettingsStore } from '@state/settingsStore';

import { GeodeticFilterReset, GeodeticFilters } from '../../map/components/GeodeticFilterPanel';
import { SubPanelHeader, SwitchRow } from '../../map/components/mapSheet';
import { setExtensionPrefs, useExtensionPrefs } from '../prefs';
import type { ExtensionSubPanelProps } from '../types';
import { geodeticHint } from './GeodeticPanelEntry';
import { GEODETIC_ICON } from './icon';

/**
 * Map overlays › Extensions › Geodetic points (#668): the extension's switch
 * first (the same value as its row, so a panel opened on its own still
 * works), then the filters, with Reset at the top right. The lifecycle
 * (offline, Remove) stays in Settings › Extensions.
 */
export function GeodeticSubPanel({ onBack }: ExtensionSubPanelProps) {
  const { show } = useExtensionPrefs('geodetic');
  const filterCount = useSettingsStore((s) => activeFilterCount(s.geodeticFilter));
  const { label, summary } = EXTENSIONS.geodetic;
  return (
    <>
      <SubPanelHeader
        title={label}
        backLabel="Back to extensions"
        onBack={onBack}
        right={<GeodeticFilterReset />}
      />
      <SwitchRow
        icon={GEODETIC_ICON}
        label="Show geodetic points"
        hint={geodeticHint(filterCount, summary)}
        value={show}
        onToggle={() => setExtensionPrefs('geodetic', { show: !show })}
      />
      <GeodeticFilters />
    </>
  );
}
