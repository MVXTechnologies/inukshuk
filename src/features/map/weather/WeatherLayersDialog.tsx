import { WEATHER_LAYERS, weatherLayerById, type WeatherLayerId } from '@core/geo/weatherLayers';
import { useMapStore } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import { Button, Checkbox, Dialog, Divider, Portal, RadioButton, Text } from 'react-native-paper';

/**
 * "Weather" picker: one live ECCC GeoMet layer at a time (radar rain/snow,
 * HRDPS wind or precipitation) draped over the map, plus the bounded radar
 * animation toggle for the radar layers. Mirrors TrailNetworksDialog —
 * user-invoked dialog, so Portal is safe here (the launch-path Portal ban in
 * [[paper-portal-touch-swallow]] doesn't apply).
 */
export function WeatherLayersDialog({
  visible,
  onDismiss,
}: {
  visible: boolean;
  onDismiss: () => void;
}) {
  const weatherLayer = useSettingsStore((s) => s.weatherLayer);
  const set = useSettingsStore((s) => s.set);
  const animating = useMapStore((s) => s.weatherAnimating);
  const toggleAnimation = useMapStore((s) => s.toggleWeatherAnimation);
  const animatable = weatherLayer !== null && weatherLayerById(weatherLayer).animatable;

  return (
    <Portal>
      <Dialog visible={visible} onDismiss={onDismiss}>
        <Dialog.Title>Weather</Dialog.Title>
        <Dialog.Content>
          <Text variant="bodySmall" style={{ opacity: 0.7, marginBottom: 4 }}>
            Live layers from Environment and Climate Change Canada, draped over the map. Needs a
            connection; hidden while &quot;Locally downloaded only&quot; is on.
          </Text>
          <RadioButton.Group
            value={weatherLayer ?? 'none'}
            onValueChange={(v) => set('weatherLayer', v === 'none' ? null : (v as WeatherLayerId))}
          >
            <RadioButton.Item
              label="None"
              value="none"
              position="leading"
              labelStyle={{ textAlign: 'left' }}
            />
            {WEATHER_LAYERS.map((l) => (
              <RadioButton.Item
                key={l.id}
                label={l.label}
                value={l.id}
                position="leading"
                labelStyle={{ textAlign: 'left' }}
              />
            ))}
          </RadioButton.Group>
          {animatable && (
            <>
              <Divider />
              <Checkbox.Item
                label="Animate radar"
                status={animating ? 'checked' : 'unchecked'}
                onPress={toggleAnimation}
                position="leading"
                labelStyle={{ textAlign: 'left' }}
              />
            </>
          )}
        </Dialog.Content>
        <Dialog.Actions>
          <Button onPress={onDismiss}>Done</Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}
