import { TideLegend } from '../../map/components/TideLegend';
import { SwitchRow } from '../../map/components/mapSheet';
import { setExtensionPrefs, useExtensionPrefs } from '../prefs';

/** Map overlays › Extensions › Tide stations: its switch and legend. */
export function TidePanelEntry() {
  const { show } = useExtensionPrefs('tides');
  return (
    <SwitchRow
      icon="waves"
      label="Tide stations"
      hint="Gauges, tidal levels, chart datum"
      value={show}
      onToggle={() => setExtensionPrefs('tides', { show: !show })}
      below={<TideLegend disabled={!show} />}
    />
  );
}
