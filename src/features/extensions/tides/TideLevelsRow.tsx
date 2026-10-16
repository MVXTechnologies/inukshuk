/**
 * Tide stations › "Show levels on the map" (#764), in both places the
 * extension's options live: the overlays sheet's sub-panel (`SwitchRow`) and
 * Settings › Extensions › Tide stations (a list row). Shown only while the
 * stations are drawn: no greyed-out row (sub-menu rule).
 */
import { useSettingsStore } from '@state/settingsStore';
import { List, Switch } from '@ui/paper';

import { SwitchRow } from '../../map/components/mapSheet';

export const TIDE_LEVELS_LABEL = 'Show levels on the map';
export const TIDE_LEVELS_HINT = 'Water level by each station';

function useLevelsSwitch(): [boolean, () => void] {
  const on = useSettingsStore((s) => s.tideLevelsOnMap);
  const set = useSettingsStore((s) => s.set);
  return [on, () => set('tideLevelsOnMap', !on)];
}

/** The sub-panel's row. */
export function TideLevelsSwitchRow() {
  const [on, toggle] = useLevelsSwitch();
  return (
    <SwitchRow
      icon="chart-bell-curve"
      label={TIDE_LEVELS_LABEL}
      hint={TIDE_LEVELS_HINT}
      value={on}
      onToggle={toggle}
    />
  );
}

/** The Settings row. */
export function TideLevelsSettingsItem() {
  const [on, toggle] = useLevelsSwitch();
  return (
    <List.Item
      title={TIDE_LEVELS_LABEL}
      description={TIDE_LEVELS_HINT}
      onPress={toggle}
      right={() => (
        <Switch value={on} onValueChange={toggle} accessibilityLabel={TIDE_LEVELS_LABEL} />
      )}
    />
  );
}
