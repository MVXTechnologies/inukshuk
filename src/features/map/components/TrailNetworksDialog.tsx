import { TRAIL_NETWORKS, type TrailNetworkId } from '@core/geo/trailNetworks';
import { toggleId } from '@core/library/toggleId';
import { useSettingsStore } from '@state/settingsStore';
import { Button, Checkbox, Dialog, Portal, Text } from 'react-native-paper';

/**
 * "Marked trails" picker: a popup listing the checkable trail databases
 * (Waymarked Trails networks); each checked one drapes as its own tile
 * overlay on the main map. User-invoked dialog — Portal is safe here (the
 * launch-path Portal ban in [[paper-portal-touch-swallow]] doesn't apply).
 */
export function TrailNetworksDialog({
  visible,
  onDismiss,
}: {
  visible: boolean;
  onDismiss: () => void;
}) {
  const networks = useSettingsStore((s) => s.markedTrailsNetworks);
  const set = useSettingsStore((s) => s.set);

  return (
    <Portal>
      <Dialog visible={visible} onDismiss={onDismiss}>
        <Dialog.Title>Marked trails</Dialog.Title>
        <Dialog.Content>
          <Text variant="bodySmall" style={{ opacity: 0.7, marginBottom: 4 }}>
            Route networks from Waymarked Trails, draped over the map.
          </Text>
          {TRAIL_NETWORKS.map((n) => (
            <Checkbox.Item
              key={n.id}
              label={n.label}
              status={networks.includes(n.id) ? 'checked' : 'unchecked'}
              onPress={() =>
                set('markedTrailsNetworks', toggleId(networks, n.id) as TrailNetworkId[])
              }
              position="leading"
              labelStyle={{ textAlign: 'left' }}
            />
          ))}
        </Dialog.Content>
        <Dialog.Actions>
          <Button onPress={onDismiss}>Done</Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}
