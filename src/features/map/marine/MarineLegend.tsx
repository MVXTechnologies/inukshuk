import { DEPTH_BAND_BREAKS_M, DEPTH_BANDS } from '@core/geo/depthChart';
import { useSettingsStore } from '@state/settingsStore';
import { StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';

import { weatherChrome as wc } from '../weather/weatherChrome';

const M_TO_FT = 3.28084;

/**
 * Depth legend for marine chart mode (marine wave D §D2): the same slim
 * floating pill idiom as the weather legend, but showing the QUANTIZED chart
 * bands rather than a continuous ramp — one flat swatch per band with the
 * band edge printed at each boundary, which is exactly what the drape does.
 * The trailing band is open-ended (10 m+ chart white), so its label sits at
 * its leading edge like every other break.
 *
 * Fixed dark chrome in both themes (weatherChrome.ts), plain Views only.
 */
export function MarineLegend() {
  const imperial = useSettingsStore((s) => s.units === 'imperial');
  const unit = imperial ? 'ft' : 'm';
  const label = (m: number): string =>
    m === 0 ? '0' : Math.round(imperial ? m * M_TO_FT : m).toString();

  return (
    <View style={styles.pill} pointerEvents="none" accessibilityLabel="Depth legend">
      <View style={styles.unitCell}>
        <Text style={styles.unitText}>{unit}</Text>
      </View>
      <View style={styles.bands}>
        {DEPTH_BANDS.map((band) => (
          <View key={band.color} style={[styles.band, { backgroundColor: band.color }]} />
        ))}
        <View style={styles.labels}>
          {DEPTH_BAND_BREAKS_M.map((m) => (
            <Text key={m} style={styles.labelText}>
              {label(m)}
            </Text>
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    height: 22,
    borderRadius: 11,
    overflow: 'hidden',
    backgroundColor: wc.panel,
    marginHorizontal: 10,
  },
  unitCell: { paddingHorizontal: 9, justifyContent: 'center' },
  unitText: { fontSize: 11, lineHeight: 14, color: wc.inkMuted },
  bands: { flex: 1, flexDirection: 'row' },
  band: { flex: 1 },
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
    // The band swatches are pale chart colours, so the legend's own ink is
    // dark here (the weather legend rides saturated ramps and uses white).
    color: '#1B2730',
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
});
