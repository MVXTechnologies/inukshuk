import { findCategory } from '@core/library/categories';
import type { TrackSummary } from '@core/models';
import { formatDistance, formatDuration, formatTimestamp } from '@lib/format';
import { useLibraryStore } from '@state/libraryStore';
import { useEffect, useMemo } from 'react';
import { PanResponder, Pressable, StyleSheet, View } from 'react-native';
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
/** How far the previous/next cards peek out from behind the focused one. */
const PEEK = 14;
/** Vertical swipe distance that steps the deck one card. */
const SWIPE_STEP = 24;

/**
 * Right-edge activity deck opened by tapping a "hot" (overlapping) spot on
 * the heat-shaded trail layers. A 3D-stacked vertical carousel: only the
 * focused card shows in full; its neighbours peek out above (newer — the
 * list is newest-at-top) and below (older), scaled down behind it. Chevrons
 * appear only when a neighbour exists in that direction — the deck is
 * bounded, never circular. Step with the chevrons, a vertical swipe on the
 * deck, or by tapping a peeking card; tapping the focused card opens it.
 * The focused card drives which trail's `tracks-heat-focus` layer highlights
 * on the map (see MapScreen).
 *
 * A plain themed `View`, NOT paper's `Surface`: an absolutely-positioned
 * Surface's iOS shadow nesting leaves its content wrapper unconstrained,
 * collapsing internal flex columns (the map-maker drawer bug, #131-adjacent).
 * NOT a paper `Portal`/`Dialog` either — see `CategoryStartSheet`'s doc
 * comment: an invisible Portal overlay can soft-lock touches on devices with
 * animations disabled. This is a conditionally-mounted absolute view.
 *
 * No ScrollView on purpose: the previous snap-scroll implementation's
 * momentum handler could fight programmatic focus changes (tap-to-focus
 * intermittently no-opped). Explicit stepping has no such feedback loop.
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

  const items = trackIds
    .map((id) => tracks.find((t) => t.id === id))
    .filter((t): t is TrackSummary => t !== undefined);

  // A track backing the tapped spot vanished (deleted/trimmed) while the
  // deck was open — nothing left to show, so close it instead of rendering
  // an empty stack the user can't dismiss any other way.
  useEffect(() => {
    if (items.length === 0) onClose();
  }, [items.length, onClose]);

  // Swipe up reveals the older card below; swipe down the newer one above.
  // Recreated via useMemo when the focus/count change (the ElevationProfile
  // recipe) so the release handler always closes over current values —
  // gestures span multiple renders but attach fresh on the next one.
  const count = items.length;
  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) =>
          Math.abs(g.dy) > 10 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderRelease: (_e, g) => {
          if (g.dy <= -SWIPE_STEP && focusedIdx < count - 1) onFocus(focusedIdx + 1);
          else if (g.dy >= SWIPE_STEP && focusedIdx > 0) onFocus(focusedIdx - 1);
        },
      }),
    [focusedIdx, count, onFocus],
  );

  if (items.length === 0) return null;

  const clamped = Math.max(0, Math.min(focusedIdx, items.length - 1));
  const focusedItem = items[clamped];
  if (!focusedItem) return null;
  const newer = clamped > 0 ? items[clamped - 1] : undefined;
  const older = clamped < items.length - 1 ? items[clamped + 1] : undefined;

  const card = (t: TrackSummary, kind: 'focused' | 'newer' | 'older') => {
    const category = findCategory(t.category, customCategories);
    const untimed = t.stats.durationS <= 0;
    const focused = kind === 'focused';
    return (
      <Pressable
        key={t.id}
        onPress={() =>
          focused ? onOpenTrail(t.id) : onFocus(kind === 'newer' ? clamped - 1 : clamped + 1)
        }
        accessibilityLabel={`Activity: ${t.name}`}
        style={[
          styles.card,
          { backgroundColor: theme.colors.elevation.level3 },
          focused
            ? { borderColor: theme.colors.primary, zIndex: 2 }
            : [
                styles.peek,
                kind === 'newer' ? styles.peekAbove : styles.peekBelow,
                { backgroundColor: theme.colors.elevation.level1 },
              ],
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
  };

  return (
    <View
      style={[
        styles.container,
        { top: topInset + 90, backgroundColor: theme.colors.elevation.level2 },
      ]}
      accessibilityLabel="Activities here"
    >
      <View style={styles.headerRow}>
        <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
          {`${clamped + 1} of ${items.length}`}
        </Text>
        <IconButton
          icon="close"
          size={16}
          style={styles.closeBtn}
          onPress={onClose}
          accessibilityLabel="Close activities"
        />
      </View>
      <View style={styles.arrowRow}>
        {newer !== undefined && (
          <IconButton
            icon="chevron-up"
            size={18}
            style={styles.arrow}
            onPress={() => onFocus(clamped - 1)}
            accessibilityLabel="Newer activity"
          />
        )}
      </View>
      {/* Focused card FIRST in the tree (a11y index 0 — the E2E contract taps
          it to open the viewer) but on top visually via zIndex. */}
      <View style={styles.deck} {...pan.panHandlers}>
        {card(focusedItem, 'focused')}
        {newer !== undefined && card(newer, 'newer')}
        {older !== undefined && card(older, 'older')}
      </View>
      <View style={styles.arrowRow}>
        {older !== undefined && (
          <IconButton
            icon="chevron-down"
            size={18}
            style={styles.arrow}
            onPress={() => onFocus(clamped + 1)}
            accessibilityLabel="Older activity"
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    right: 8,
    width: 200,
    borderRadius: 14,
    paddingHorizontal: 8,
    paddingBottom: 4,
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingLeft: 8,
  },
  closeBtn: { margin: 0 },
  arrowRow: { height: 22, alignItems: 'center', justifyContent: 'center' },
  arrow: { margin: 0, height: 22, width: 44 },
  // The deck is one card tall; neighbours peek out from behind the focused
  // card via absolute offsets + a shrink, giving the stacked-depth look.
  deck: { height: CARD_H + PEEK * 2, justifyContent: 'center' },
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
  peek: {
    position: 'absolute',
    left: 0,
    right: 0,
    opacity: 0.55,
    transform: [{ scale: 0.92 }],
  },
  peekAbove: { top: 0 },
  peekBelow: { bottom: 0 },
  cardText: { flex: 1, gap: 1 },
});
