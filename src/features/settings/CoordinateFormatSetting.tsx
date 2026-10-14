import {
  COORDINATE_FORMATS,
  formatCoordinate,
  isCoordinateFormat,
  type CoordinateFormat,
} from '@core/convert/coordinateDisplay';
import { useSettingsStore } from '@state/settingsStore';
import { StyleSheet, View } from 'react-native';
import { List, SegmentedButtons } from 'react-native-paper';

/** DD, DMS, DDM, UTM, MGRS: short labels that fit five segments at 360 dp. */
const OPTIONS = COORDINATE_FORMATS.map((f) => ({
  value: f.value,
  label: f.label,
  accessibilityLabel: f.name,
  testID: `coordinate-format-${f.value}`,
}));

/** A point near Québec City, written in each format as the row's live sample. */
const SAMPLE = { latitude: 46.81394, longitude: -71.20761 };

/** "Decimal degrees · 46.81394, -71.20761": the format's name and a sample in it. */
export function coordinateFormatDescription(fmt: CoordinateFormat): string {
  const name = COORDINATE_FORMATS.find((f) => f.value === fmt)?.name ?? '';
  return `${name} · ${formatCoordinate(SAMPLE.latitude, SAMPLE.longitude, fmt)}`;
}

/**
 * Settings › Display › Coordinates (#677, owner decision 2026-10-13): how the
 * app writes a position everywhere it shows one: the map's coordinates chip,
 * waypoint cards and their copy actions (`useCoordinateFormatter`). Decimal
 * degrees by default. The description shows a sample in the chosen format.
 */
export function CoordinateFormatSetting() {
  const fmt = useSettingsStore((s) => s.coordinateFormat);
  const set = useSettingsStore((s) => s.set);
  return (
    <>
      <List.Item title="Coordinates" description={coordinateFormatDescription(fmt)} />
      <View style={styles.segment}>
        <SegmentedButtons
          value={fmt}
          onValueChange={(v) => {
            if (isCoordinateFormat(v)) set('coordinateFormat', v);
          }}
          buttons={OPTIONS}
        />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  // Same inset as the Units and Theme segments above and below it.
  segment: { paddingHorizontal: 16, paddingBottom: 8 },
});
