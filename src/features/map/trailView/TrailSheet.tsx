import type { ChartSeries } from '@core/geo/track';
import { sheetAfterDrag, sheetDragOffset, type TrailSheet } from '@core/library/trailSheet';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useMemo, useState } from 'react';
import {
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  View,
  type GestureResponderHandlers,
} from 'react-native';
import { IconButton, Text } from 'react-native-paper';

import { TrailChart } from './TrailChart';

/**
 * The trail view's pull-down sheet (#740, mockup 262 screen 1, option 1):
 * drag the grabber down and the tabs fold into a peek — the stats and a
 * scrubbable profile — while the map grows to fill; drag up, or tap the
 * chevron, for the full tabs. The action bar stays either way.
 */

/**
 * Vertical drags on a sheet handle: the sheet follows the finger (`offset`,
 * a translateY) and settles folded or unfolded on release.
 */
export function useSheetDrag(
  state: TrailSheet,
  onSettle: (next: TrailSheet) => void,
): { offset: Animated.Value; handlers: GestureResponderHandlers } {
  const [offset] = useState(() => new Animated.Value(0));
  // Rebuilt only when the sheet folds or unfolds (`onSettle` is a state setter).
  const handlers = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) =>
          Math.abs(g.dy) > 6 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderMove: (_e, g) => offset.setValue(sheetDragOffset(state, g.dy)),
        onPanResponderRelease: (_e, g) => {
          offset.setValue(0);
          const next = sheetAfterDrag(state, g.dy, g.vy);
          if (next !== state) onSettle(next);
        },
        onPanResponderTerminate: () => offset.setValue(0),
      }).panHandlers,
    [offset, state, onSettle],
  );
  return { offset, handlers };
}

/** The unfolded sheet's handle, over the tabs: drag it down (or tap it) to fold. */
export function SheetGrabber({
  onFold,
  handlers,
}: {
  onFold: () => void;
  handlers: GestureResponderHandlers;
}) {
  const t = useSchemeTokens();
  return (
    <View {...handlers} style={[styles.grabRow, { backgroundColor: t.surface }]}>
      <Pressable
        onPress={onFold}
        accessibilityRole="button"
        accessibilityLabel="Fold the details"
        hitSlop={{ top: 8, bottom: 8, left: 40, right: 40 }}
        style={styles.grabHit}
        testID="trail-sheet-fold"
      >
        <View style={[styles.grab, { backgroundColor: t.outlineVariant }]} />
      </Pressable>
    </View>
  );
}

interface PeekProps {
  /** "12.4 km", "+640 m", "3:42" — the first one bold. */
  stats: readonly string[];
  series: ChartSeries | null;
  cursorDistanceM: number | null;
  onScrub: (distanceM: number) => void;
  /** Photo spots along the profile (small ticks, as on Overview). */
  dots?: readonly number[];
  onUnfold: () => void;
  handlers: GestureResponderHandlers;
  offset: Animated.Value;
  /** Space below for the action bar (and the safe area). */
  bottom: number;
  color: string;
}

/** The folded sheet: grabber, stats with the unfold chevron, the profile to scrub. */
export function TrailPeek({
  stats,
  series,
  cursorDistanceM,
  onScrub,
  dots,
  onUnfold,
  handlers,
  offset,
  bottom,
  color,
}: PeekProps) {
  const t = useSchemeTokens();
  return (
    <Animated.View
      style={[
        styles.peek,
        {
          backgroundColor: t.surface,
          shadowColor: palette.shadow,
          paddingBottom: bottom,
          transform: [{ translateY: offset }],
        },
      ]}
      testID="trail-peek"
    >
      <View {...handlers}>
        <View style={[styles.grab, styles.grabPeek, { backgroundColor: t.outlineVariant }]} />
        <View style={styles.peekRow}>
          <View style={styles.peekStats}>
            {stats.map((s, i) => (
              <Text
                key={`${i}-${s}`}
                style={[
                  styles.stat,
                  i === 0 ? styles.statLead : null,
                  { color: i === 0 ? t.ink : t.inkVariant },
                ]}
              >
                {s}
              </Text>
            ))}
          </View>
          <IconButton
            icon="chevron-up"
            size={24}
            onPress={onUnfold}
            accessibilityLabel="Show the details"
            testID="trail-sheet-unfold"
            style={styles.chevron}
          />
        </View>
      </View>
      {series?.elevation ? (
        <View style={styles.profile}>
          <TrailChart
            bare
            title="Elevation"
            valueText=""
            distances={series.distances}
            totalM={series.totalM}
            values={series.elevation}
            color={color}
            area
            plotHeight={56}
            cursorDistanceM={cursorDistanceM}
            onScrub={onScrub}
            {...(dots ? { dots } : {})}
            testID="peek-elevation"
          />
        </View>
      ) : (
        <View style={styles.noProfile} />
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  grabRow: { alignItems: 'center' },
  grabHit: { paddingVertical: 7, paddingHorizontal: 24 },
  grab: { width: 36, height: 4, borderRadius: 2 },
  grabPeek: { alignSelf: 'center', marginTop: 8, marginBottom: 2 },
  peek: {
    marginTop: -20,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: -4 },
    elevation: 8,
  },
  peekRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 16,
    paddingRight: 4,
  },
  peekStats: { flexDirection: 'row', gap: 14, flexShrink: 1 },
  stat: { fontSize: 14, fontWeight: '700' },
  statLead: { fontWeight: '800' },
  chevron: { margin: 0 },
  profile: { paddingHorizontal: 16, paddingBottom: 8 },
  noProfile: { height: 16 },
});
