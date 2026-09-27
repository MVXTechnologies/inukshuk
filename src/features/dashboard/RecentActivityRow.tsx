import { activityCaption, activityStatsLine } from '@core/dashboard/logbook';
import { findCategory, type CustomCategory } from '@core/library/categories';
import type { Units } from '@core/format';
import type { TrackSummary } from '@core/models';
import { tabularNums } from '@ui/fonts';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import Svg, { Path } from 'react-native-svg';

/**
 * One Logbook "Recent" row (revamp `After-Logbook.html`, spec §5 trail row):
 * 76 dp, a 56 dp thumbnail with the 20 dp activity badge on its corner
 * (decision 7), name 16/700, stats `11.2 km · 3:31 · ↑1068 m` (14, tabular,
 * never truncated) and the caption `Aug 29 · Hike`. The whole row opens the
 * trail.
 *
 * TODO(ui-revamp 7): the Library is building the same row (with a real route
 * thumbnail drawn from the simplified track) in parallel. Once both land,
 * replace this with the shared Library row; until then the thumbnail here is a
 * contour-texture placeholder, because a TrackSummary carries no geometry.
 */

const THUMB = 56;
const BADGE = 20;

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
  const stats = activityStatsLine(track.stats, units);
  const caption = activityCaption(track.startedAt, category?.name ?? null);

  return (
    <Pressable
      onPress={() => onPress(track.id)}
      accessibilityRole="button"
      accessibilityLabel={`${track.name}, ${stats}, ${caption}`}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.thumbWrap}>
        <View
          style={[
            styles.thumb,
            { backgroundColor: tokens.elevation.level1, borderColor: tokens.divider },
          ]}
        >
          <Svg width={THUMB} height={THUMB} viewBox="0 0 56 56">
            <Path
              d="M-2 18C12 12 26 22 58 14M-2 34C14 28 30 40 58 30M-2 50C16 44 30 52 58 46"
              fill="none"
              stroke={tokens.outlineVariant}
              strokeWidth={1}
            />
          </Svg>
        </View>
        {category !== null && (
          <View
            style={[styles.badge, { backgroundColor: tokens.surface, borderColor: category.color }]}
          >
            <Icon source={category.icon} size={13} color={category.color} />
          </View>
        )}
      </View>
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
  thumbWrap: { width: THUMB, height: THUMB },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
  },
  badge: {
    position: 'absolute',
    right: -5,
    bottom: -5,
    width: BADGE,
    height: BADGE,
    borderRadius: BADGE / 2,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { flex: 1, minWidth: 0, gap: 2 },
  name: { fontSize: 16, lineHeight: 21, fontWeight: '700' },
  stats: { fontSize: 14, lineHeight: 19, fontWeight: '600' },
  caption: { fontSize: 12, lineHeight: 16 },
});
