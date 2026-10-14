import { EXTENSIONS } from '@core/extensions/registry';

import { SubPanelButton, SwitchRow } from '../../map/components/mapSheet';
import { setExtensionPrefs, useExtensionPrefs } from '../prefs';
import type { ExtensionPanelEntryProps } from '../types';

/**
 * Map overlays › Extensions › Tide stations: one row, its switch, its
 * summary and the sub-panel accessory (the gauge symbols and the sources are
 * in its sub-panel, `TideSubPanel`).
 */
export function TidePanelEntry({ onOpenPanel }: ExtensionPanelEntryProps) {
  const { show } = useExtensionPrefs('tides');
  const { label, summary } = EXTENSIONS.tides;
  return (
    <SwitchRow
      icon="waves"
      label={label}
      hint={summary}
      value={show}
      onToggle={() => setExtensionPrefs('tides', { show: !show })}
      accessory={
        <SubPanelButton onPress={onOpenPanel} accessibilityLabel={`Options for ${label}`} />
      }
    />
  );
}
