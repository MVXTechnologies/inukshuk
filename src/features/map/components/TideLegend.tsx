import { tideColors } from '@core/map/tideStyle';
import { Image, StyleSheet, View } from 'react-native';
import { Icon, Text, useTheme } from '@ui/paper';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { tideImage } from '../tideImages';
import { useDisplayScale, useScaledStyles } from '@ui/displayScale';

type LevelKind = 'live' | 'pred' | 'stale';

/** One level label as the map draws it (`buildTideLevelLayers`), for the legend. */
function LevelSample({ kind, text, arrow }: { kind: LevelKind; text: string; arrow: boolean }) {
  const styles = useScaledStyles(stylesSheet);
  const { sz } = useDisplayScale();
  const c = tideColors(useTheme().dark ? 'dark' : 'light');
  const bg = kind === 'live' ? c.station : kind === 'stale' ? c.levelStale : c.labelHalo;
  const ink = kind === 'live' ? c.levelInk : c.label;
  return (
    <View
      style={[
        styles.pill,
        { backgroundColor: bg },
        kind === 'pred' && { borderColor: c.station, borderWidth: 1.3 },
      ]}
    >
      <Text variant="labelSmall" style={[styles.pillText, { color: ink }]}>
        {text}
      </Text>
      {arrow && <Icon source="arrow-top-right" size={sz(11)} color={ink} />}
    </View>
  );
}

/**
 * Under the overlays menu's "Tide stations" switch: the two station symbols
 * (filled = live gauge, hollow = predictions / historic), the level labels'
 * three looks while "Show levels on the map" is on (#764), and the coverage
 * note — Canada's CHS stations are not in this layer (owner decision: CHS
 * stays live-only).
 */
export function TideLegend({
  disabled = false,
  levels = false,
}: {
  disabled?: boolean;
  levels?: boolean;
}) {
  const styles = useScaledStyles(stylesSheet);

  const tokens = useSchemeTokens();
  const theme = useTheme().dark ? 'dark' : 'light';
  const color = disabled ? tokens.inkMuted : tokens.ink;
  const live = tideImage(theme, true);
  const pred = tideImage(theme, false);
  return (
    <View
      style={[styles.wrap, disabled && styles.disabled]}
      accessibilityLabel="Gauge symbols legend"
    >
      <View style={styles.row}>
        <View style={styles.entry}>
          {live !== undefined && <Image source={live} style={styles.icon} />}
          <Text variant="labelSmall" style={{ color }}>
            Live gauge
          </Text>
        </View>
        <View style={styles.entry}>
          {pred !== undefined && <Image source={pred} style={styles.icon} />}
          <Text variant="labelSmall" style={{ color }}>
            Predictions / historic
          </Text>
        </View>
      </View>
      {levels && (
        <View style={styles.row} accessibilityLabel="Water level labels legend">
          <View style={styles.entry}>
            <LevelSample kind="live" text="1.3 m" arrow />
            <Text variant="labelSmall" style={{ color }}>
              Live
            </Text>
          </View>
          <View style={styles.entry}>
            <LevelSample kind="pred" text="1.3 m" arrow />
            <Text variant="labelSmall" style={{ color }}>
              Predicted
            </Text>
          </View>
          <View style={styles.entry}>
            <LevelSample kind="stale" text="1.0 m · 2 h" arrow={false} />
            <Text variant="labelSmall" style={{ color }}>
              Old
            </Text>
          </View>
        </View>
      )}
      <Text variant="labelSmall" style={{ color: tokens.inkMuted }}>
        Canada (CHS, live) · USA · France · Norway · Japan
      </Text>
    </View>
  );
}

const stylesSheet = StyleSheet.create({
  wrap: { gap: 2 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, rowGap: 4 },
  entry: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  icon: { width: 15, height: 15 },
  disabled: { opacity: 0.5 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 1,
    borderRadius: 9,
    paddingHorizontal: 6,
    height: 18,
  },
  pillText: { fontWeight: '700', fontVariant: ['tabular-nums'] },
});
