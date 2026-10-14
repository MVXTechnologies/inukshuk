import { DEVICE_EXTENSIONS } from '@core/extensions/registry';
import { useTeamStore } from '@state/teamStore';

import { SubPanelButton, SwitchRow } from '../../map/components/mapSheet';
import { setExtensionPrefs, useExtensionPrefs } from '../prefs';
import type { ExtensionPanelEntryProps } from '../types';

/**
 * Map overlays › Extensions › Team mode: its switch IS team signal mode (taps
 * on the map signal the team; the team bar and the SOS button appear). The hint names the
 * open team; the sub-panel accessory (`TeamSubPanel`: the hub, sharing,
 * create, join) carries the unread count.
 */
export function TeamPanelEntry({ onOpenPanel }: ExtensionPanelEntryProps) {
  const { show } = useExtensionPrefs('team');
  const name = useTeamStore((s) => s.view?.name ?? null);
  const unread = useTeamStore((s) => s.unread);
  const { label } = DEVICE_EXTENSIONS.team;
  const hint =
    name === null
      ? 'No team yet · create or join one'
      : `${name}${unread > 0 ? ` · ${unread} unread` : ''}${show ? ' · taps signal the team' : ''}`;
  return (
    <SwitchRow
      icon="account-group"
      label={label}
      hint={hint}
      value={show}
      onToggle={() => setExtensionPrefs('team', { show: !show })}
      accessibilityLabel="Team mode on the map"
      accessory={
        <SubPanelButton
          onPress={onOpenPanel}
          badge={unread}
          accessibilityLabel={
            unread > 0 ? `Options for ${label}, ${unread} unread` : `Options for ${label}`
          }
        />
      }
    />
  );
}
