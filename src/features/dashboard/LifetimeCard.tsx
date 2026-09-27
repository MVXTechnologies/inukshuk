import {
  heroClimb,
  heroDistance,
  heroTime,
  sinceLabel,
  type HeroValue,
} from '@core/dashboard/logbook';
import { lifetimeTotals } from '@core/dashboard/lifetime';
import type { Units } from '@core/format';
import type { TrackSummary } from '@core/models';
import { tabularNums } from '@ui/fonts';
import { radius, space } from '@ui/tokens';
import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text, useTheme } from 'react-native-paper';

/**
 * The Logbook's lifetime hero (revamp `After-Logbook.html`): a stone card with
 * distance, time and climb over every activity the screen is showing (the
 * type filter narrows it, like the rest of the screen). Stone on paper in the
 * light scheme; in stone night the inverse surface keeps it a raised block
 * rather than a stone slab lost on the night ground.
 */
export function LifetimeCard({
  tracks,
  units,
  typeName,
}: {
  /** Already filtered to what the Logbook shows (performed, maybe one type). */
  tracks: readonly TrackSummary[];
  units: Units;
  /** The active type filter's name, or null for every activity. */
  typeName: string | null;
}) {
  const theme = useTheme();
  const bg = theme.colors.inverseSurface;
  const ink = theme.colors.inverseOnSurface;
  const totals = useMemo(() => lifetimeTotals(tracks), [tracks]);
  const since = useMemo(() => sinceLabel(tracks), [tracks]);

  const distance = heroDistance(totals.distanceM, units);
  const time = heroTime(totals.movingTimeS > 0 ? totals.movingTimeS : totals.durationS);
  const climb = heroClimb(totals.ascentM, units);
  const label = ['LIFETIME', typeName?.toUpperCase(), since]
    .filter((p): p is string => p !== undefined && p !== null)
    .join(' · ');

  const spoken = (v: HeroValue) => `${v.value} ${v.unit}`;

  return (
    <View
      accessible
      accessibilityLabel={`Lifetime totals: ${spoken(distance)}, ${spoken(time)}, ${spoken(climb)} climbed`}
      style={[styles.card, { backgroundColor: bg }]}
    >
      <Text numberOfLines={1} style={[styles.caps, styles.dim, { color: ink }]}>
        {label}
      </Text>
      <View style={styles.row}>
        <Hero value={distance} label="DISTANCE" ink={ink} />
        <View style={[styles.rule, { backgroundColor: ink }]} />
        <Hero value={time} label="TIME" ink={ink} />
        <View style={[styles.rule, { backgroundColor: ink }]} />
        <Hero value={climb} label="↑ CLIMBED" ink={ink} />
      </View>
    </View>
  );
}

function Hero({ value, label, ink }: { value: HeroValue; label: string; ink: string }) {
  return (
    <View style={styles.cell}>
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        maxFontSizeMultiplier={1.4}
        style={[styles.value, tabularNums, { color: ink }]}
      >
        {value.value}
        {/* Paper's Text sets its own theme colour, so a nested span must be
            given the card's ink explicitly or it renders dark on stone. */}
        <Text style={[styles.unit, { color: ink }]}> {value.unit}</Text>
      </Text>
      <Text
        numberOfLines={1}
        maxFontSizeMultiplier={1.4}
        style={[styles.caps, styles.dim, { color: ink }]}
      >
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    paddingVertical: 14,
    paddingHorizontal: space.lg,
    gap: space.sm,
  },
  caps: { fontSize: 12, lineHeight: 16, fontWeight: '700', letterSpacing: 1 },
  // Paper at 82 % over stone is ~7:1 — the board's #D9D2C3, from the theme.
  dim: { opacity: 0.82 },
  row: { flexDirection: 'row' },
  cell: { flex: 1, minWidth: 0, gap: 1 },
  rule: { width: 1, opacity: 0.2, marginRight: space.md },
  value: { fontSize: 26, lineHeight: 30, fontWeight: '800' },
  unit: { fontSize: 15, fontWeight: '600' },
});
