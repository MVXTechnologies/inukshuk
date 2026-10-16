import { legendInUnits, type WeatherLayer } from '@core/geo/weatherLayers';
import { useSettingsStore } from '@state/settingsStore';
import { interpolateRamp } from '@core/weather/colorRamp';
import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '@ui/paper';

import { weatherChrome as wc } from './weatherChrome';
import { useScaledStyles } from '@ui/displayScale';

/**
 * Windy-style value legend (weather UX M1 polish): a slim floating pill just
 * above the time scrubber — a leading unit cell ("°C", "km/h", "mm/h") and
 * the layer's colour ramp, smoothly interpolated from its swatch stops, with
 * value labels evenly spaced along it. Same fixed dark chrome in both themes
 * as the scrubber (weatherChrome.ts). The label values approximate GeoMet's
 * default WMS styles — device QA calibrates them against the live drape.
 */
export function WeatherLegend({ layer }: { layer: WeatherLayer }) {
  const styles = useScaledStyles(stylesSheet);

  const ramp = useMemo(() => interpolateRamp(layer.swatch, RAMP_STEPS), [layer]);
  const units = useSettingsStore((s) => s.units);
  const legend = legendInUnits(layer, units);

  return (
    <View style={styles.pill} pointerEvents="none">
      <View style={styles.unitCell}>
        <Text style={styles.unitText}>{legend.unit}</Text>
      </View>
      <View style={styles.ramp}>
        {ramp.map((color, i) => (
          // Colours can repeat after interpolation; suffix with the position.
          <View key={`${color}-${i}`} style={[styles.rampStep, { backgroundColor: color }]} />
        ))}
        <View style={styles.labels}>
          {legend.labels.map((v) => (
            <Text key={v} style={styles.labelText}>
              {v}
            </Text>
          ))}
        </View>
      </View>
    </View>
  );
}

/** Enough steps that 300+ px of ramp reads as a continuous gradient. */
const RAMP_STEPS = 32;

const stylesSheet = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    height: 22,
    borderRadius: 11,
    overflow: 'hidden',
    backgroundColor: wc.panel,
    // Narrower than the scrubber pill so it reads as a floating element
    // (edge-to-edge it looked like a glued-on strip — Windy's legend floats).
    marginHorizontal: 10,
  },
  unitCell: { paddingHorizontal: 9, justifyContent: 'center' },
  unitText: { fontSize: 11, lineHeight: 14, color: wc.inkMuted },
  ramp: { flex: 1, flexDirection: 'row' },
  rampStep: { flex: 1 },
  labels: {
    ...StyleSheet.absoluteFill,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
  },
  labelText: {
    fontSize: 11,
    lineHeight: 14,
    color: wc.ink,
    fontVariant: ['tabular-nums'],
    textShadowColor: 'rgba(0, 0, 0, 0.5)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 2,
  },
});
