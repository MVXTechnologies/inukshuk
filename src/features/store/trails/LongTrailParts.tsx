import { trailThumb, type LongTrail } from '@core/trails/schema';
import { tabularNums } from '@ui/fonts';
import { space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';

import { TrailThumb } from './TrailThumb';

/**
 * The long-distance trail card (Explore's carousel, board `Main.dc.html`) and
 * list row (board `List.dc.html`). Presentational: screens own ranking and
 * navigation.
 */

export const TRAIL_CARD_WIDTH = 220;
const TRAIL_CARD_IMAGE_HEIGHT = 132;
const ROW_THUMB = 64;

export const LongTrailCard = memo(function LongTrailCard({
  trail,
  title,
  meta,
  distance,
  onPress,
}: {
  trail: LongTrail;
  title: string;
  meta: string;
  distance: string | null;
  onPress: () => void;
}) {
  const t = useSchemeTokens();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={[title, meta, distance].filter(Boolean).join(', ')}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <View style={[styles.cardImage, { borderColor: t.outlineVariant }]}>
        <TrailThumb
          parts={trailThumb(trail)}
          width={TRAIL_CARD_WIDTH - 2}
          height={TRAIL_CARD_IMAGE_HEIGHT - 2}
          seed={trail.id}
          insetBottom={distance !== null ? 38 : 0}
        />
        {distance !== null && (
          <View style={[styles.distanceBadge, { backgroundColor: t.surface }]}>
            <Text style={[styles.distanceText, tabularNums, { color: t.inkVariant }]}>
              {distance}
            </Text>
          </View>
        )}
      </View>
      <Text numberOfLines={2} style={[styles.cardTitle, { color: t.ink }]}>
        {title}
      </Text>
      <Text numberOfLines={1} style={[styles.cardMeta, { color: t.inkMuted }]}>
        {meta}
      </Text>
    </Pressable>
  );
});

export const LongTrailRow = memo(function LongTrailRow({
  trail,
  title,
  meta,
  distance,
  onPress,
}: {
  trail: LongTrail;
  title: string;
  meta: string;
  distance: string | null;
  onPress: () => void;
}) {
  const t = useSchemeTokens();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={[title, meta, distance].filter(Boolean).join(', ')}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={[styles.rowThumb, { borderColor: t.outlineVariant }]}>
        <TrailThumb
          parts={trailThumb(trail)}
          width={ROW_THUMB - 2}
          height={ROW_THUMB - 2}
          seed={trail.id}
          stroke={3}
          contours={false}
        />
      </View>
      <View style={styles.rowText}>
        <Text numberOfLines={2} style={[styles.rowTitle, { color: t.ink }]}>
          {title}
        </Text>
        <Text numberOfLines={2} style={[styles.rowMeta, { color: t.inkMuted }]}>
          {meta}
        </Text>
      </View>
      {distance !== null && (
        <Text style={[styles.rowDistance, tabularNums, { color: t.inkMuted }]}>{distance}</Text>
      )}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  pressed: { opacity: 0.85 },
  card: { width: TRAIL_CARD_WIDTH, gap: 6 },
  cardImage: {
    width: TRAIL_CARD_WIDTH,
    height: TRAIL_CARD_IMAGE_HEIGHT,
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
  },
  distanceBadge: {
    position: 'absolute',
    left: space.sm,
    bottom: space.sm,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
  },
  distanceText: { fontSize: 12, lineHeight: 15, fontWeight: '700' },
  cardTitle: { fontSize: 15, lineHeight: 19, fontWeight: '700' },
  cardMeta: { fontSize: 13, lineHeight: 17 },
  row: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: 10,
    paddingHorizontal: space.lg,
  },
  rowThumb: {
    width: ROW_THUMB,
    height: ROW_THUMB,
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  rowText: { flex: 1, minWidth: 0, gap: 3 },
  rowTitle: { fontSize: 16, lineHeight: 20, fontWeight: '700' },
  rowMeta: { fontSize: 13, lineHeight: 17 },
  rowDistance: { fontSize: 13, lineHeight: 17, fontWeight: '700' },
});
