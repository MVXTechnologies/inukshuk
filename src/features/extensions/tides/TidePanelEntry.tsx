import { EXTENSIONS } from '@core/extensions/registry';

import { SwitchRow } from '../../map/components/mapSheet';
import { setExtensionPrefs, useExtensionPrefs } from '../prefs';

/**
 * Map overlays › Extensions › Tide stations: one row, its switch and its
 * summary (the gauge symbols are in Settings › Extensions, in its details).
 */
export function TidePanelEntry() {
  const { show } = useExtensionPrefs('tides');
  const { label, summary } = EXTENSIONS.tides;
  return (
    <SwitchRow
      icon="waves"
      label={label}
      hint={summary}
      value={show}
      onToggle={() => setExtensionPrefs('tides', { show: !show })}
    />
  );
}
