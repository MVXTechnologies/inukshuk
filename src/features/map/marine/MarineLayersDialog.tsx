import {
  CHS_NONNA_ATTRIBUTION,
  MARINE_LAYERS,
  OPENSEAMAP_ATTRIBUTION,
  type MarineLayerId,
} from '@core/geo/marineLayers';
import { toggleId } from '@core/library/toggleId';
import { useSettingsStore } from '@state/settingsStore';
import { Button, Checkbox, Dialog, Portal, Text } from 'react-native-paper';

/**
 * "Marine" picker (marine M3): checkable reference layers — CHS NONNA
 * bathymetry and OpenSeaMap seamarks — each draped as its own raster overlay
 * on the main map. The dialog body states the non-navigational condition and
 * both licence lines (CHS Open Government Licence, OpenSeaMap ODbL); while
 * any layer is checked the map itself shows the persistent "Not for
 * navigation" chip. Mirrors TrailNetworksDialog — user-invoked dialog, so
 * Portal is safe here (the launch-path Portal ban in
 * [[paper-portal-touch-swallow]] doesn't apply).
 */
export function MarineLayersDialog({
  visible,
  onDismiss,
}: {
  visible: boolean;
  onDismiss: () => void;
}) {
  const marineLayers = useSettingsStore((s) => s.marineLayers);
  const set = useSettingsStore((s) => s.set);

  return (
    <Portal>
      <Dialog visible={visible} onDismiss={onDismiss}>
        <Dialog.Title>Marine</Dialog.Title>
        <Dialog.Content>
          <Text variant="bodySmall" style={{ opacity: 0.7, marginBottom: 4 }}>
            Reference depths and seamarks for the St. Lawrence and other charted Canadian waters,
            draped over the map. Reference only — not for navigation. Needs a connection; hidden
            while &quot;Locally downloaded only&quot; is on.
          </Text>
          {MARINE_LAYERS.map((l) => (
            <Checkbox.Item
              key={l.id}
              label={l.label}
              status={marineLayers.includes(l.id) ? 'checked' : 'unchecked'}
              onPress={() => set('marineLayers', toggleId(marineLayers, l.id) as MarineLayerId[])}
              position="leading"
              labelStyle={{ textAlign: 'left' }}
            />
          ))}
          <Text variant="labelSmall" style={{ opacity: 0.6, marginTop: 4 }}>
            {CHS_NONNA_ATTRIBUTION}
            {'\n'}
            {OPENSEAMAP_ATTRIBUTION}
          </Text>
        </Dialog.Content>
        <Dialog.Actions>
          <Button onPress={onDismiss}>Done</Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}
