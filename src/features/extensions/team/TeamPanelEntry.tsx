import { DEVICE_EXTENSIONS } from '@core/extensions/registry';
import { useTeamStore } from '@state/teamStore';

import { SwitchRow } from '../../map/components/mapSheet';
import { setExtensionPrefs, useExtensionPrefs } from '../prefs';

/**
 * Map overlays › Extensions › Team mode: its switch IS team signal mode (taps
 * on the map signal the team; the team button appears). The hint names the
 * open team and its unread count.
 */
export function TeamPanelEntry() {
  const { show } = useExtensionPrefs('team');
  const name = useTeamStore((s) => s.view?.name ?? null);
  const unread = useTeamStore((s) => s.unread);
  const { label } = DEVICE_EXTENSIONS.team;
  const hint =
    name === null
      ? 'No team open · Settings › Extensions'
      : `${name}${unread > 0 ? ` · ${unread} unread` : ''}${show ? ' · taps signal the team' : ''}`;
  return (
    <SwitchRow
      icon="account-group"
      label={label}
      hint={hint}
      value={show}
      onToggle={() => setExtensionPrefs('team', { show: !show })}
      accessibilityLabel="Team mode on the map"
    />
  );
}
