import { findCategory } from '@core/library/categories';
import type { TrackSummary } from '@core/models';
import { formatDistance, formatDuration, formatTimestamp } from '@lib/format';
import { useLibraryStore } from '@state/libraryStore';
import { useCallback, useEffect, useRef } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { Icon, IconButton, Text, useTheme } from 'react-native-paper';

interface Props {
  /** Newest-first trail ids sharing the tapped heat spot (from `heatAt`). */
  trackIds: readonly string[];
  /** Full track summaries; ids are mapped to summaries here. */
  tracks: readonly TrackSummary[];
  focusedIdx: number;
  onFocus: (idx: number) => void;
  onOpenTrail: (id: string) => void;
  onClose: () => void;
  topInset: number;
}

const CARD_H = 64;
const GAP = 8;
const MAX_VISIBLE = 4;

/**
 * Right-edge carousel opened by tapping a "hot" (overlapping) spot on the
 * heat-shaded trail layers. Lists every trail under the tap, newest first;
 * the focused card drives which trail's `tracks-heat-focus` layer highlights
 * on the map (see MapScreen). Tapping the already-focused card opens it
 * (`onOpenTrail`); tapping any other card just focuses it.
 *
 * A plain themed `View`, NOT paper's `Surface`: an absolutely-positioned
 * Surface's iOS shadow nesting leaves its content wrapper unconstrained,
 * collapsing internal flex columns (the map-maker drawer bug, #131-adjacent).
 * This component sidesteps that entirely with an explicit `maxHeight` on the
 * ScrollView instead of `flex: 1`, same as `CategoryStartSheet`'s chip list.
 *
 * NOT a paper `Portal`/`Dialog` either — see `CategoryStartSheet`'s doc
 * comment: an invisible Portal overlay can soft-lock touches on devices with
 * animations disabled. This is a conditionally-mounted absolute view instead.
 */
export function HeatPointCarousel({
  trackIds,
  tracks,
  focusedIdx,
  onFocus,
  onOpenTrail,
  onClose,
  topInset,
}: Props) {
  const theme = useTheme();
  const customCategories = useLibraryStore((s) => s.customCategories);
  const scrollRef = useRef<ScrollView>(null);

  const items = trackIds
    .map((id) => tracks.find((t) => t.id === id))
    .filter((t): t is TrackSummary => t !== undefined);

  // Keep the scroll position in sync when focus changes from outside the
  // ScrollView's own momentum handler (e.g. tapping a non-focused card, or
  // the initial open at focusedIdx 0).
  useEffect(() => {
    scrollRef.current?.scrollTo({ y: focusedIdx * (CARD_H + GAP), animated: true });
  }, [focusedIdx]);

  // A track backing the tapped spot vanished (deleted/trimmed) while the
  // carousel was open — nothing left to show, so close it instead of
  // rendering an empty stack the user can't dismiss any other way.
  useEffect(() => {
    if (items.length === 0) onClose();
  }, [items.length, onClose]);

  const handleMomentumEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const idx = Math.round(e.nativeEvent.contentOffset.y / (CARD_H + GAP));
      onFocus(Math.max(0, Math.min(idx, items.length - 1)));
    },
    [onFocus, items.length],
  );

  if (items.length === 0) return null;

  return (
    <View
      style={[
        styles.container,
        { top: topInset + 90, backgroundColor: theme.colors.elevation.level2 },
      ]}
      accessibilityLabel="Activities here"
    >
      <View style={styles.closeRow}>
        <IconButton
          icon="close"
          size={16}
          style={styles.closeBtn}
          onPress={onClose}
          accessibilityLabel="Close activities"
        />
      </View>
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        snapToInterval={CARD_H + GAP}
        decelerationRate="fast"
        onMomentumScrollEnd={handleMomentumEnd}
      >
        {items.map((t, idx) => {
          const category = findCategory(t.category, customCategories);
          const focused = idx === focusedIdx;
          const untimed = t.stats.durationS <= 0;
          return (
            <Pressable
              key={t.id}
              onPress={() => (focused ? onOpenTrail(t.id) : onFocus(idx))}
              accessibilityLabel={`Activity: ${t.name}`}
              style={[
                styles.card,
                { backgroundColor: theme.colors.elevation.level3 },
                focused && { borderColor: theme.colors.primary },
              ]}
            >
              <Icon
                source={category?.icon ?? 'circle-medium'}
                size={18}
                color={category?.color ?? theme.colors.onSurfaceVariant}
              />
              <View style={styles.cardText}>
                <Text variant="labelMedium" numberOfLines={1}>
                  {t.name}
                </Text>
                <Text
                  variant="labelSmall"
                  numberOfLines={1}
                  style={{ color: theme.colors.onSurfaceVariant }}
                >
                  {formatTimestamp(t.startedAt)}
                </Text>
                <Text variant="labelSmall" numberOfLines={1}>
                  {[
                    formatDistance(t.stats.distanceM),
                    ...(untimed ? [] : [formatDuration(t.stats.durationS)]),
                  ].join(' · ')}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    right: 8,
    width: 200,
    borderRadius: 14,
    paddingHorizontal: 4,
    paddingBottom: 4,
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  closeRow: { flexDirection: 'row', justifyContent: 'flex-end' },
  closeBtn: { margin: 0 },
  scroll: { maxHeight: CARD_H * MAX_VISIBLE + GAP * (MAX_VISIBLE - 1) },
  scrollContent: { gap: GAP, paddingHorizontal: 4, paddingBottom: 4 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: CARD_H,
    borderRadius: 10,
    paddingHorizontal: 8,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  cardText: { flex: 1, gap: 1 },
});
