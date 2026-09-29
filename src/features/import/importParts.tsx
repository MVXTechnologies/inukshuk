import type { ActivitySourceId } from '@core/import/sources';
import { tabularNums } from '@ui/fonts';
import { space, target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import Svg, { Path } from 'react-native-svg';

/**
 * Small shared pieces of the import UI (#432/#435, boards
 * `ImportSheet` / `ImportProgress` / `ImportDone` / `Main`): the source tile,
 * the source mark on imported rows, the progress bar and the two pill
 * buttons. Colours come from the scheme tokens only.
 */

export type SourceTileKind = ActivitySourceId | 'garmin' | 'files';

/** Strava's two-peak mark, as drawn on the boards. */
function StravaGlyph({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M4 20L10 6l6 14" stroke={color} strokeWidth={2.4} strokeLinejoin="round" />
      <Path d="M13 20l3-7 3 7" stroke={color} strokeWidth={2.4} strokeLinejoin="round" />
    </Svg>
  );
}

const TILE_ICON: Record<Exclude<SourceTileKind, 'strava'>, string> = {
  'apple-health': 'heart-pulse',
  'health-connect': 'heart-pulse',
  garmin: 'watch-variant',
  files: 'file-download-outline',
};

/** A source's square tile: Strava orange, Garmin stone, the rest paper. */
export function SourceTile({ kind, size = 44 }: { kind: SourceTileKind; size?: number }) {
  const t = useSchemeTokens();
  const glyph = Math.round(size * 0.55);
  const box: ViewStyle = {
    width: size,
    height: size,
    borderRadius: Math.round(size * 0.27),
    alignItems: 'center',
    justifyContent: 'center',
  };
  if (kind === 'strava') {
    return (
      <View style={[box, { backgroundColor: t.connect.brand }]}>
        <StravaGlyph size={glyph} color={t.connect.onBrand} />
      </View>
    );
  }
  const dark = kind === 'garmin';
  return (
    <View style={[box, { backgroundColor: dark ? t.library.chipOn : t.surfaceVariant }]}>
      <Icon
        source={TILE_ICON[kind]}
        size={glyph}
        color={dark ? t.library.chipOnInk : t.inkVariant}
      />
    </View>
  );
}

/** "Strava" — the small bordered mark on a trail imported from a source. */
export function SourceMark({ label }: { label: string }) {
  const t = useSchemeTokens();
  return (
    <View
      style={[styles.mark, { borderColor: t.connect.markBorder }]}
      accessibilityLabel={`Imported from ${label}`}
    >
      <Text style={[styles.markLabel, { color: t.connect.mark }]}>{label}</Text>
    </View>
  );
}

export function ProgressBar({ value, label }: { value: number; label: string }) {
  const t = useSchemeTokens();
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <View
      style={[styles.track, { backgroundColor: t.connect.progressTrack }]}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: pct }}
    >
      <View style={[styles.fill, { width: `${pct}%`, backgroundColor: t.connect.progress }]} />
    </View>
  );
}

/** A pill button: `primary` (stone fill) or outlined. */
export function PillButton({
  label,
  onPress,
  primary,
  disabled,
  busy,
  grow = 1,
  compact,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
  busy?: boolean;
  grow?: number;
  compact?: boolean;
  accessibilityLabel?: string;
}) {
  const t = useSchemeTokens();
  const inert = disabled || busy;
  return (
    <Pressable
      onPress={onPress}
      disabled={inert}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!inert, busy: !!busy }}
      style={({ pressed }) => [
        styles.pill,
        compact ? styles.pillCompact : { flexGrow: grow, flexBasis: 0 },
        primary
          ? { backgroundColor: t.library.chipOn }
          : { borderWidth: 1, borderColor: t.outline },
        (pressed || inert) && styles.dim,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={primary ? t.library.chipOnInk : t.ink} />
      ) : (
        <Text
          style={[
            styles.pillLabel,
            primary ? { color: t.library.chipOnInk, fontWeight: '700' } : { color: t.ink },
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

/** A rounded card on the surface colour with a hairline. */
export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const t = useSchemeTokens();
  return (
    <View
      style={[styles.card, { backgroundColor: t.surface, borderColor: t.outlineVariant }, style]}
    >
      {children}
    </View>
  );
}

/** A number over a caption ("39 / new trails"). */
export function CountTile({ value, label }: { value: number; label: string }) {
  const t = useSchemeTokens();
  return (
    <View style={[styles.countTile, { backgroundColor: t.elevation.level2 }]}>
      <Text style={[styles.countValue, { color: t.ink }]}>{value.toLocaleString('en-US')}</Text>
      <Text style={[styles.countLabel, { color: t.inkMuted }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  mark: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 1,
    flexShrink: 0,
  },
  markLabel: { fontSize: 12, lineHeight: 16, fontWeight: '700' },
  track: { height: 8, borderRadius: 4, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 4 },
  pill: {
    minHeight: target.min,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  pillCompact: { minHeight: 44, flexGrow: 0 },
  pillLabel: { fontSize: 15, lineHeight: 20, fontWeight: '600', textAlign: 'center' },
  dim: { opacity: 0.6 },
  card: {
    borderWidth: 1,
    borderRadius: 18,
    overflow: 'hidden',
  },
  countTile: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: space.md,
    gap: 2,
  },
  countValue: { fontSize: 20, lineHeight: 26, fontWeight: '700', ...tabularNums },
  countLabel: { fontSize: 12.5, lineHeight: 16 },
});
