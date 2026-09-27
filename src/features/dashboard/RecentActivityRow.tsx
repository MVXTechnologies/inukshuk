import { activityCaption, activityStatsLine } from '@core/dashboard/logbook';
import { findCategory, type CustomCategory } from '@core/library/categories';
import type { Units } from '@core/format';
import type { TrackSummary } from '@core/models';
import { tabularNums } from '@ui/fonts';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import { TrailThumbnail } from '../library/components/Thumbnails';
import { useRouteThumbnail } from '../library/useRouteThumbnail';

/**
 * One Logbook "Recent" row (revamp `After-Logbook.html`, spec §5 trail row):
 * 76 dp, the Library's 56 dp route thumbnail with the 20 dp activity badge on
 * its corner (decision 7), name 16/700, stats `11.2 km · 3:31 · ↑1068 m` (14,
 * tabular, never truncated) and the caption `Aug 29 · Hike`. The whole row
 * opens the trail.
 */

export const RecentActivityRow = memo(function RecentActivityRow({
  track,
  units,
  customCategories,
  onPress,
}: {
  track: TrackSummary;
  units: Units;
  customCategories: readonly CustomCategory[];
  onPress: (id: string) => void;
}) {
  const tokens = useSchemeTokens();
  const category = findCategory(track.category, customCategories);
  const thumb = useRouteThumbnail(track);
  const stats = activityStatsLine(track.stats, units);
  const caption = activityCaption(track.startedAt, category?.name ?? null);

  return (
    <Pressable
      onPress={() => onPress(track.id)}
      accessibilityRole="button"
      accessibilityLabel={`${track.name}, ${stats}, ${caption}`}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <TrailThumbnail trackId={track.id} thumb={thumb} category={category} />
      <View style={styles.text}>
        <Text numberOfLines={1} style={[styles.name, { color: tokens.ink }]}>
          {track.name}
        </Text>
        <Text style={[styles.stats, tabularNums, { color: tokens.ink }]}>{stats}</Text>
        <Text numberOfLines={1} style={[styles.caption, { color: tokens.inkMuted }]}>
          {caption}
        </Text>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: {
    minHeight: 76,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  pressed: { opacity: 0.85 },
  text: { flex: 1, minWidth: 0, gap: 2 },
  name: { fontSize: 16, lineHeight: 21, fontWeight: '700' },
  stats: { fontSize: 14, lineHeight: 19, fontWeight: '600' },
  caption: { fontSize: 12, lineHeight: 16 },
});
