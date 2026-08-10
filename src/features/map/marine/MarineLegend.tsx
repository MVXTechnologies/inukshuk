import { DEPTH_BAND_BREAKS_M, DEPTH_BANDS } from '@core/geo/depthChart';
import { marineSourceCaption, type MarineSource } from '@core/geo/marineSources';
import { useSettingsStore } from '@state/settingsStore';
import { StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';

import { weatherChrome as wc } from '../weather/weatherChrome';

const M_TO_FT = 3.28084;

/**
 * Depth legend for marine chart mode (marine wave D §D2, source line added
 * in §D3): the same slim floating slab idiom as the weather legend, but
 * showing the QUANTIZED chart bands rather than a continuous ramp — one flat
 * swatch per band with the band edge printed at each boundary, which is
 * exactly what the drape does. The trailing band is open-ended (10 m+ chart
 * white), so its label sits at its leading edge like every other break.
 *
 * The caption above the ramp names the source that actually rendered —
 * "CHS NONNA · 10 m" vs "GEBCO 2025 · ~450 m" — because the ladder can and
 * does fall through, and a 450 m global compilation must never be mistaken
 * for a hydrographic survey. A downloaded pack says "Offline" instead of
 * hiding the fact that nothing was fetched.
 *
 * Fixed dark chrome in both themes (weatherChrome.ts), plain Views only.
 */
export function MarineLegend({
  source,
  offline = false,
}: {
  source: MarineSource | null;
  offline?: boolean;
}) {
  const imperial = useSettingsStore((s) => s.units === 'imperial');
  const unit = imperial ? 'ft' : 'm';
  const label = (m: number): string =>
    m === 0 ? '0' : Math.round(imperial ? m * M_TO_FT : m).toString();

  return (
    <View style={styles.slab} pointerEvents="none" accessibilityLabel="Depth legend">
      {source !== null && (
        <View style={styles.captionRow}>
          <Text style={styles.caption} numberOfLines={1}>
            {marineSourceCaption(source)}
          </Text>
          {offline && (
            <View style={styles.offlineTag}>
              <Text style={styles.offlineText}>Offline</Text>
            </View>
          )}
        </View>
      )}
      <View style={styles.pill}>
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
    </View>
  );
}

const styles = StyleSheet.create({
  slab: {
    backgroundColor: wc.panel,
    borderRadius: 12,
    marginHorizontal: 10,
    paddingHorizontal: 4,
    paddingTop: 4,
    paddingBottom: 4,
    gap: 4,
  },
  captionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 7,
  },
  caption: {
    flexShrink: 1,
    fontSize: 11,
    lineHeight: 14,
    color: wc.inkMuted,
    letterSpacing: 0.2,
  },
  offlineTag: {
    borderRadius: 6,
    paddingHorizontal: 5,
    paddingVertical: 1,
    backgroundColor: wc.accent,
  },
  offlineText: { fontSize: 9, lineHeight: 12, fontWeight: '700', color: wc.onAccent },
  pill: {
    flexDirection: 'row',
    height: 22,
    borderRadius: 8,
    overflow: 'hidden',
  },
  unitCell: { paddingHorizontal: 7, justifyContent: 'center' },
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
