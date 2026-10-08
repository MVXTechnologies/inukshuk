import { DEVICE_EXTENSIONS } from '@core/extensions/registry';
import { useReceiverChip } from '@features/gnss/useReceiverChip';
import { useGnssStore } from '@state/gnssStore';
import { IconButton } from 'react-native-paper';

import { SwitchRow } from '../../map/components/mapSheet';
import { setExtensionPrefs, useExtensionPrefs } from '../prefs';
import type { ExtensionPanelEntryProps } from '../types';

/**
 * Map overlays › Extensions › External GNSS receiver: one row, its switch
 * (use the receiver) and the fix state as its hint ("RTK fixed · ±3 cm", or
 * "Not connected"); the chevron opens the receiver sheet.
 */
export function GnssPanelEntry({ onClose }: ExtensionPanelEntryProps) {
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
        show ? (
          <IconButton
            icon="chevron-right"
            onPress={() => {
              onClose();
              useGnssStore.getState().setSheetOpen(true);
            }}
            accessibilityLabel="Open the receiver"
            testID="extension-gnss-open"
          />
        ) : undefined
      }
    />
  );
}
