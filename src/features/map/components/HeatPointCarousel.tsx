import { findCategory } from '@core/library/categories';
import type { TrackSummary } from '@core/models';
import { formatDistance, formatDuration, formatTimestamp } from '@lib/format';
import { useLibraryStore } from '@state/libraryStore';
import { useEffect, useMemo, useState } from 'react';
import { Animated, PanResponder, Pressable, StyleSheet, View } from 'react-native';
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

const CARD_H = 84;
/** Vertical distance between card centres in the stack: a neighbour peeks
 * only ~25% of its height out from behind the focused card. */
const PEEK = Math.round(CARD_H * 0.25);
/** Swipe distance that commits a one-card step on release. */
const SWIPE_STEP = 24;

/**
 * Top-right activity deck opened by tapping a "hot" (overlapping) spot on the
 * heat-shaded trail layers — layered directly over MapControlsRail (v4:
 * smaller footprint, chevrons folded into the header). A 3D vertical
 * carousel: the focused card in front, its neighbours peeking a sliver
 * behind it (newer above — the list is newest-at-top — older below),
 * slightly shrunk and dimmed for depth. Swiping animates the whole stack (a
 * spring drives every card's translate/scale/opacity off one animated
 * index); the header's chevrons appear only when a neighbour exists in that
 * direction — bounded, never circular. Tapping a peeking card focuses it;
 * tapping the focused card opens it. The focused card drives which trail's
 * layer highlights on the map (see MapScreen).
 *
 * A plain themed `View`, NOT paper's `Surface` (iOS absolute-Surface flex
 * collapse) and NOT a `Portal`/`Dialog` (invisible-overlay touch swallow
 * with animations off) — see CategoryStartSheet's doc comments. Elevation is
 * set explicitly (Android z-ordering over the FAB rail it now overlaps).
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
  const count = items.length;
  const clamped = Math.max(0, Math.min(focusedIdx, count - 1));

  // One animated "float index" positions every card: card i sits at
  // (i - anim) slots from centre. The spring chases focusedIdx; the pan
  // handler drags it continuously for the carousel feel.
  const [anim] = useState(() => new Animated.Value(0));
  useEffect(() => {
    Animated.spring(anim, {
      toValue: clamped,
      useNativeDriver: true,
      friction: 9,
      tension: 80,
    }).start();
  }, [clamped, anim]);

  // A track backing the tapped spot vanished (deleted/trimmed) while the
  // deck was open — nothing left to show, so close it instead of rendering
  // an empty stack the user can't dismiss any other way.
  useEffect(() => {
    if (count === 0) onClose();
  }, [count, onClose]);

  // Drag moves the stack live (one step max per gesture, rubber-banded at
  // the ends); release either commits the step via onFocus — the spring
  // then settles on the new index — or springs back. Recreated when
  // focus/count change (the ElevationProfile recipe) so callbacks always
  // close over current values.
  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) =>
          Math.abs(g.dy) > 10 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderMove: (_e, g) => {
          const raw = clamped - g.dy / PEEK;
          const lo = Math.max(0, clamped - 1);
          const hi = Math.min(count - 1, clamped + 1);
          // Soft clamp: allow a 20% overshoot at the hard ends for feel.
          anim.setValue(Math.max(lo - 0.2, Math.min(hi + 0.2, raw)));
        },
        onPanResponderRelease: (_e, g) => {
          let target = clamped;
          if (g.dy <= -SWIPE_STEP && clamped < count - 1) target = clamped + 1;
          else if (g.dy >= SWIPE_STEP && clamped > 0) target = clamped - 1;
          if (target !== clamped) onFocus(target);
          // Same index: spring back from wherever the drag left the stack.
          else
            Animated.spring(anim, {
              toValue: clamped,
              useNativeDriver: true,
              friction: 9,
              tension: 80,
            }).start();
        },
        onPanResponderTerminate: () => {
          Animated.spring(anim, {
            toValue: clamped,
            useNativeDriver: true,
            friction: 9,
            tension: 80,
          }).start();
        },
      }),
    [clamped, count, onFocus, anim],
  );

  if (count === 0) return null;
  const focusedItem = items[clamped];
  if (!focusedItem) return null;

  const card = (t: TrackSummary, idx: number) => {
    const category = findCategory(t.category, customCategories);
    const untimed = t.stats.durationS <= 0;
    const focused = idx === clamped;
    const translateY = anim.interpolate({
      inputRange: [idx - 1, idx, idx + 1],
      outputRange: [PEEK, 0, -PEEK],
      extrapolate: 'extend',
    });
    const scale = anim.interpolate({
      inputRange: [idx - 1, idx, idx + 1],
      outputRange: [0.88, 1, 0.88],
      extrapolate: 'clamp',
    });
    const opacity = anim.interpolate({
      inputRange: [idx - 1, idx, idx + 1],
      outputRange: [0.55, 1, 0.55],
      extrapolate: 'clamp',
    });
    return (
      <Animated.View
        key={t.id}
        style={[
          styles.cardSlot,
          { transform: [{ translateY }, { scale }], opacity, zIndex: focused ? 2 : 1 },
        ]}
      >
        <Pressable
          onPress={() => (focused ? onOpenTrail(t.id) : onFocus(idx))}
          accessibilityLabel={`Activity: ${t.name}`}
          style={[
            styles.card,
            {
              backgroundColor: focused
                ? theme.colors.elevation.level3
                : theme.colors.elevation.level1,
              borderColor: focused ? theme.colors.primary : 'transparent',
            },
          ]}
        >
          <Icon
            source={category?.icon ?? 'circle-medium'}
            size={22}
            color={category?.color ?? theme.colors.onSurfaceVariant}
          />
          <View style={styles.cardText}>
            <Text variant="titleSmall" numberOfLines={1}>
              {t.name}
            </Text>
            <Text
              variant="labelSmall"
              numberOfLines={1}
              style={{ color: theme.colors.onSurfaceVariant }}
            >
              {formatTimestamp(t.startedAt)}
            </Text>
            <Text variant="labelMedium" numberOfLines={1}>
              {[
                formatDistance(t.stats.distanceM),
                ...(untimed ? [] : [formatDuration(t.stats.durationS)]),
              ].join(' · ')}
            </Text>
          </View>
        </Pressable>
      </Animated.View>
    );
  };

  // Render the focused card and its immediate neighbours; the focused card
  // comes FIRST in the tree (a11y index 0 — the E2E contract taps it to
  // open the viewer) but sits on top visually via zIndex.
  const rendered = [clamped, clamped - 1, clamped + 1].filter((i) => i >= 0 && i < count);

  return (
    <View
      style={[
        styles.container,
        { top: topInset + 8, backgroundColor: theme.colors.elevation.level2 },
      ]}
      accessibilityLabel="Activities here"
    >
      {/* Header: chevrons flank the "N of M" counter, then a spacer pushes
          close to the far edge — the separate arrow rows above/below the
          deck are gone (v4: much smaller footprint). */}
      <View style={styles.headerRow}>
        {clamped > 0 && (
          <IconButton
            icon="chevron-up"
            size={14}
            style={styles.headerArrow}
            onPress={() => onFocus(clamped - 1)}
            accessibilityLabel="Newer activity"
          />
        )}
        <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
          {`${clamped + 1} of ${count}`}
        </Text>
        {clamped < count - 1 && (
          <IconButton
            icon="chevron-down"
            size={14}
            style={styles.headerArrow}
            onPress={() => onFocus(clamped + 1)}
            accessibilityLabel="Older activity"
          />
        )}
        <View style={styles.headerSpacer} />
        <IconButton
          icon="close"
          size={14}
          style={styles.closeBtn}
          onPress={onClose}
          accessibilityLabel="Close activities"
        />
      </View>
      <View style={styles.deck} {...pan.panHandlers}>
        {rendered.map((i) => {
          const t = items[i];
          return t ? card(t, i) : null;
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Top-right, layered directly over MapControlsRail — user preference (v4).
  // elevation (Android) + the shadow* props (iOS) keep it above the rail's
  // own FABs regardless of native z-ordering quirks.
  container: {
    position: 'absolute',
    right: 8,
    width: 168,
    borderRadius: 14,
    paddingHorizontal: 6,
    paddingBottom: 4,
    zIndex: 10,
    elevation: 10,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 4,
  },
  headerArrow: { margin: 0, height: 22, width: 22 },
  headerSpacer: { flex: 1 },
  closeBtn: { margin: 0, height: 22, width: 22 },
  // Tall enough for the focused card plus a ~25%-visible neighbour on each
  // side; every card lives in the same centred slot and is displaced by the
  // animated transforms alone.
  deck: { height: CARD_H + PEEK * 2, justifyContent: 'center' },
  cardSlot: { position: 'absolute', left: 0, right: 0, top: PEEK },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: CARD_H,
    borderRadius: 10,
    paddingHorizontal: 10,
    borderWidth: 2,
  },
  cardText: { flex: 1, gap: 3 },
});
