import { scaleBar } from '@core/geo/scaleBar';
import { useSettingsStore } from '@state/settingsStore';
import { StyleSheet, View } from 'react-native';
import { Surface, Text, useTheme } from 'react-native-paper';

/**
 * The map scale bar, docked under the compass badge in the top-left column.
 *
 * Placement: the compass and the scale are the map's two *reference*
 * instruments, so they read as one small stack. The bottom-left corner — the
 * cartographic default — was deliberately cleared of chrome (the old
 * logo/attribution) and now belongs to the recording HUD, so nothing new goes
 * back there.
 *
 * It updates on camera SETTLE, not during the gesture: `onRegionIsChanging`
 * fires at gesture rate and every event here would re-render the whole
 * MapScreen tree (the same trap the wind overlay's own settled-bounds state
 * documents). A scale that snaps to its final value the instant you lift your
 * finger is the right trade.
 *
 * Both the bar length and its label come from `@core/geo/scaleBar`, which is
 * latitude-aware — one pixel is ~8× less ground at 83°N (the top of the map
 * sheets this app ships) than at the equator — and picks a round 1/2/5 × 10ⁿ
 * distance in the user's units.
 */

/** Longest bar we will draw, in dp. Wide enough to read, narrow enough to hide. */
const MAX_BAR_PX = 104;

export function ScaleBar({ zoom, latitude }: { zoom: number; latitude: number }) {
  const theme = useTheme();
  // Subscribed, not read per call: the bar must re-label the moment the unit
  // system flips, and it is cheap to re-render (see `@state/formatters`).
  const units = useSettingsStore((s) => s.units);
  const bar = scaleBar(zoom, latitude, MAX_BAR_PX, units);
  if (bar === null) return null;

  return (
    <Surface
      style={[styles.pill, { backgroundColor: theme.colors.elevation?.level2 }]}
      elevation={3}
      accessibilityLabel={`Scale ${bar.label}`}
    >
      <Text variant="labelSmall" style={styles.label}>
        {bar.label}
      </Text>
      <View
        style={[
          styles.bar,
          { width: Math.round(bar.widthPx), borderColor: theme.colors.onSurface },
        ]}
      />
    </Surface>
  );
}

const styles = StyleSheet.create({
  pill: {
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingTop: 4,
    paddingBottom: 6,
    alignItems: 'flex-start',
    gap: 2,
  },
  label: { fontVariant: ['tabular-nums'] },
  // A classic bar: a baseline with an upright tick at each end.
  bar: {
    height: 6,
    borderLeftWidth: 2,
    borderRightWidth: 2,
    borderBottomWidth: 2,
  },
});
