import {
  DISTANCE_UNITS,
  ELEVATION_UNITS,
  distanceUnitLabel,
  formatDistance,
  formatElevation,
  formatSpeed,
  type DistanceUnit,
  type ElevationUnit,
  type Units,
} from '@core/format';
import { useSettingsStore } from '@state/settingsStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { IconButton, List, SegmentedButtons, Text, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const DISTANCE_NAMES: Record<DistanceUnit, string> = {
  km: 'Kilometres',
  mi: 'Miles',
  nmi: 'Nautical miles',
};
const ELEVATION_NAMES: Record<ElevationUnit, string> = { m: 'Metres', ft: 'Feet' };

const DISTANCE_OPTIONS = DISTANCE_UNITS.map((u) => ({
  value: u,
  label: distanceUnitLabel(u),
  accessibilityLabel: DISTANCE_NAMES[u],
  testID: `units-distance-${u}`,
}));
const ELEVATION_OPTIONS = ELEVATION_UNITS.map((u) => ({
  value: u,
  label: u,
  accessibilityLabel: ELEVATION_NAMES[u],
  testID: `units-elevation-${u}`,
}));

const isDistanceUnit = (v: string): v is DistanceUnit =>
  (DISTANCE_UNITS as readonly string[]).includes(v);
const isElevationUnit = (v: string): v is ElevationUnit =>
  (ELEVATION_UNITS as readonly string[]).includes(v);

/** The row's description: "Kilometres · metres". */
export function unitsDescription(units: Units): string {
  return `${DISTANCE_NAMES[units.distance]} · ${ELEVATION_NAMES[units.elevation].toLowerCase()}`;
}

/** A live sample in the chosen units: "8.42 km · 120 m away · climb 640 m · 4.5 km/h". */
export function unitsSample(units: Units): string {
  return [
    formatDistance(8420, units),
    `${formatDistance(120, units)} away`,
    `climb ${formatElevation(640, units)}`,
    formatSpeed(1.25, units),
  ].join(' · ');
}

/**
 * Settings › Display › Units (#702): one row near Coordinates; its sub-panel
 * holds Distance (km / mi / NM — speed and pace follow it) and Elevation
 * (m / ft). Every distance, height, speed and pace in the app reads these.
 * The sub-panel is a plain Modal sheet (no Paper Portal: Samsung pitfall).
 */
export function UnitsSetting() {
  const units = useSettingsStore((s) => s.units);
  const [open, setOpen] = useState(false);
  return (
    <>
      <List.Item
        title="Units"
        description={unitsDescription(units)}
        onPress={() => setOpen(true)}
        right={(props) => <List.Icon {...props} icon="chevron-right" />}
        accessibilityLabel="Units"
        testID="units-row"
      />
      <UnitsSheet visible={open} onDismiss={() => setOpen(false)} />
    </>
  );
}

function UnitsSheet({ visible, onDismiss }: { visible: boolean; onDismiss: () => void }) {
  const theme = useTheme();
  const tokens = useSchemeTokens();
  const insets = useSafeAreaInsets();
  const units = useSettingsStore((s) => s.units);
  const set = useSettingsStore((s) => s.set);
  const ink = theme.colors.onSurface;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onDismiss}>
      <Pressable
        style={styles.backdrop}
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel="Close units"
      />
      <View
        style={[
          styles.sheet,
          { backgroundColor: theme.colors.surface, paddingBottom: insets.bottom + 16 },
        ]}
        testID="units-panel"
      >
        <View style={styles.header}>
          <IconButton
            icon="arrow-left"
            onPress={onDismiss}
            accessibilityLabel="Back to settings"
            iconColor={ink}
          />
          <Text style={[styles.title, { color: ink }]} accessibilityRole="header">
            Units
          </Text>
        </View>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={[styles.label, { color: ink }]}>Distance</Text>
          <SegmentedButtons
            value={units.distance}
            onValueChange={(v) => {
              if (isDistanceUnit(v)) set('units', { ...units, distance: v });
            }}
            buttons={DISTANCE_OPTIONS}
          />
          <Text style={[styles.caption, { color: tokens.inkMuted }]}>
            Speed and pace follow: km/h, mph or knots.
          </Text>

          <Text style={[styles.label, styles.gap, { color: ink }]}>Elevation</Text>
          <SegmentedButtons
            value={units.elevation}
            onValueChange={(v) => {
              if (isElevationUnit(v)) set('units', { ...units, elevation: v });
            }}
            buttons={ELEVATION_OPTIONS}
          />
          <Text style={[styles.caption, { color: tokens.inkMuted }]}>
            Heights, climbs and depths. Short distances in nautical miles use it too.
          </Text>

          <View
            style={[styles.sample, { borderColor: tokens.outlineVariant }]}
            accessibilityLabel={`Sample: ${unitsSample(units)}`}
          >
            <Text style={[styles.sampleText, { color: ink }]} testID="units-sample">
              {unitsSample(units)}
            </Text>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '85%', paddingTop: 8 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4 },
  title: { fontSize: 20, lineHeight: 26, fontWeight: '700' },
  content: { paddingHorizontal: 20, paddingBottom: 12, gap: 8 },
  label: { fontSize: 16, fontWeight: '700' },
  gap: { marginTop: 12 },
  caption: { fontSize: 13 },
  sample: {
    marginTop: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  sampleText: { fontSize: 14 },
});
