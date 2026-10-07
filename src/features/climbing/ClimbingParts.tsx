import { resolveGradeSystem, type GradeSystem } from '@core/climbing/grades';
import { bandSegments, type AccessView } from '@core/climbing/card';
import { climbingColors, type ClimbingColors } from '@core/map/climbingStyle';
import { useSettingsStore } from '@state/settingsStore';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Icon, Text, useTheme } from 'react-native-paper';

/** The user's grade system: Settings, else YDS in North America, French elsewhere. */
export function useGradeSystem(): GradeSystem {
  const setting = useSettingsStore((s) => s.climbingGradeSystem);
  const position = useSettingsStore((s) => s.lastKnownPosition);
  return resolveGradeSystem(setting, position);
}

/** The climbing palette for the current theme (granite ochre, the band hues). */
export function useClimbingColors(): ClimbingColors {
  const dark = useTheme().dark;
  return useMemo(() => climbingColors(dark ? 'dark' : 'light'), [dark]);
}

/** The crag's rounded-square badge with the rock glyph (cards, rows, Library). */
export function CragBadge({
  size = 48,
  saved = false,
  closed = false,
}: {
  size?: number;
  saved?: boolean;
  closed?: boolean;
}) {
  const c = useClimbingColors();
  const ink = closed ? c.closed : saved ? c.cragInk : c.crag;
  return (
    <View
      style={[
        styles.badge,
        {
          width: size,
          height: size,
          borderRadius: size * 0.22,
          backgroundColor: saved && !closed ? c.crag : c.cragSoft,
        },
      ]}
    >
      <Icon source="terrain" size={size * 0.55} color={ink} />
    </View>
  );
}

/** The four-colour grade bar, and optionally its legend ("≤ 5.7 · 4"). */
export function BandBar({
  bands,
  system,
  legend = true,
  height = 8,
}: {
  bands: readonly [number, number, number, number];
  system: GradeSystem;
  legend?: boolean;
  height?: number;
}) {
  const c = useClimbingColors();
  const t = useSchemeTokens();
  const segs = bandSegments(bands, system);
  if (segs.length === 0) return null;
  return (
    <View style={styles.bandWrap}>
      <View
        style={[styles.bar, { height }]}
        accessibilityRole="image"
        accessibilityLabel={`Grades: ${segs.map((s) => `${s.label}, ${s.count}`).join('; ')}`}
      >
        {segs.map((s) => (
          <View
            key={s.band}
            style={{ flex: s.share, backgroundColor: c.bands[s.band], borderRadius: height / 2 }}
          />
        ))}
      </View>
      {legend && (
        <View style={styles.legend}>
          {segs.map((s) => (
            <View key={s.band} style={styles.legendItem}>
              <View style={[styles.swatch, { backgroundColor: c.bands[s.band] }]} />
              <Text style={[styles.legendText, { color: t.inkVariant }]}>
                {`${s.label} · ${s.count}`}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

export function Pill({
  label,
  tone = 'neutral',
  icon,
}: {
  label: string;
  tone?: 'neutral' | 'crag' | 'saved' | 'warn' | 'danger';
  icon?: string;
}) {
  const t = useSchemeTokens();
  const c = useClimbingColors();
  const theme = useTheme();
  const bg =
    tone === 'crag'
      ? c.cragSoft
      : tone === 'saved'
        ? t.library.onMap
        : tone === 'danger'
          ? theme.colors.errorContainer
          : tone === 'warn'
            ? t.connect.notice
            : t.surfaceVariant;
  const ink =
    tone === 'crag'
      ? c.label
      : tone === 'saved'
        ? t.library.onMapInk
        : tone === 'danger'
          ? theme.colors.onErrorContainer
          : tone === 'warn'
            ? t.connect.noticeInk
            : t.ink;
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      {icon !== undefined && <Icon source={icon} size={15} color={ink} />}
      <Text style={[styles.pillText, { color: ink }]}>{label}</Text>
    </View>
  );
}

export function AccessPill({ access }: { access: AccessView }) {
  const icon =
    access.tone === 'danger'
      ? 'cancel'
      : access.tone === 'warn'
        ? 'alert-outline'
        : access.tone === 'ok'
          ? 'check-circle-outline'
          : 'help-circle-outline';
  const tone = access.tone === 'danger' ? 'danger' : access.tone === 'warn' ? 'warn' : 'neutral';
  return <Pill label={access.label} tone={tone} icon={icon} />;
}

const styles = StyleSheet.create({
  badge: { alignItems: 'center', justifyContent: 'center' },
  bandWrap: { gap: 6 },
  bar: { flexDirection: 'row', gap: 3, overflow: 'hidden' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 4 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  swatch: { width: 10, height: 10, borderRadius: 2 },
  legendText: { fontSize: 13, lineHeight: 17 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  pillText: { fontSize: 13, lineHeight: 17, fontWeight: '700' },
});
