import { DEVICE_EXTENSIONS } from '@core/extensions/registry';
import { useReceiverChip } from '@features/gnss/useReceiverChip';

import { SubPanelButton, SwitchRow } from '../../map/components/mapSheet';
import { setExtensionPrefs, useExtensionPrefs } from '../prefs';
import type { ExtensionPanelEntryProps } from '../types';

/**
 * Map overlays › Extensions › External GNSS receiver: one row, its switch
 * (use the receiver), the fix state as its hint ("RTK fixed · ±3 cm", or
 * "Not connected") and the sub-panel accessory (`GnssSubPanel`: status,
 * receiver, corrections, phone GPS), there whether the switch is on or off.
 */
export function GnssPanelEntry({ onOpenPanel }: ExtensionPanelEntryProps) {
  const { show } = useExtensionPrefs('gnss');
  const chip = useReceiverChip();
  const { label } = DEVICE_EXTENSIONS.gnss;
  return (
    <SwitchRow
      icon="satellite-variant"
      label={label}
      hint={show ? (chip?.label ?? 'Not connected') : 'Off · the phone’s own GPS'}
      value={show}
      onToggle={() => setExtensionPrefs('gnss', { show: !show })}
      accessibilityLabel="Use the external receiver"
      accessory={
        <SubPanelButton
          onPress={onOpenPanel}
          accessibilityLabel={`Options for ${label}`}
          testID="extension-gnss-open"
        />
      }
    />
  );
}
