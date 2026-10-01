import { formatElevation, type Units } from '@core/format';
import {
  profilePaths,
  scrubProfile,
  type DrawProfile,
  type ProfileScrubPoint,
} from '@core/draw/profile';
import { compactDistance } from '@core/library/libraryRows';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useMemo, useState } from 'react';
import {
  PanResponder,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from 'react-native';
import { Text } from 'react-native-paper';
import Svg, { Line, Path } from 'react-native-svg';

/**
 * The route's elevation profile WHILE drawing (#515): a compact strip in the
 * "Draw a route" panel, from the same DEM samples as the climb stat and the
 * saved GPX. Ochre line on a light ochre fill, the min and max elevation at
 * the left edge.
 *
 * Dragging a finger along it scrubs: a cursor on the strip, a readout
 * (distance · elevation · grade) and, through `onScrub`, a marker on the drawn
 * line; lifting the finger clears both. The strip claims the touch from its
 * first contact and never gives it up, so a drag here neither pans the map nor
 * scrolls the panel.
 *
 * The big trail-view chart (`ElevationProfile`) is 140 dp with axes and pace
 * curves — too much for a 68 dp strip — so this one is its own small chart.
 */

export const PROFILE_HEIGHT = 68;

/** Signed grade, "+12 %" / "−4 %" / "0 %". */
export function formatGrade(pct: number): string {
  const r = Math.round(pct);
  if (r === 0) return '0 %';
  return `${r > 0 ? '+' : '−'}${Math.abs(r)} %`;
}

interface Props {
  profile: DrawProfile;
  units: Units;
  /** Newer elevation is being computed: show this one dimmed. */
  dimmed?: boolean;
  /** The scrubbed point (null when released), for the map marker. */
  onScrub?: (point: ProfileScrubPoint | null) => void;
}

export function RouteProfileStrip({ profile, units, dimmed = false, onScrub }: Props) {
  const t = useSchemeTokens();
  const [width, setWidth] = useState(0);
  const [scrub, setScrub] = useState<ProfileScrubPoint | null>(null);
  const responder = useMemo(() => {
    const move = (e: GestureResponderEvent) => {
      if (width <= 0) return;
      const point = scrubProfile(profile, e.nativeEvent.locationX / width);
      setScrub(point);
      onScrub?.(point);
    };
    const end = () => {
      setScrub(null);
      onScrub?.(null);
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: move,
      onPanResponderMove: move,
      onPanResponderRelease: end,
      onPanResponderTerminate: end,
    });
  }, [profile, width, onScrub]);

  const paths = useMemo(
    () => (width > 0 ? profilePaths(profile, width, PROFILE_HEIGHT) : null),
    [profile, width],
  );

  const top = formatElevation(profile.maxM, units);
  const bottom = formatElevation(profile.minM, units);
  const cursorX = scrub !== null ? scrub.ratio * width : null;

  return (
    <View
      style={[styles.wrap, dimmed && styles.dimmed]}
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={`Elevation profile, ${compactDistance(profile.totalM, units)}, ${bottom} to ${top}${dimmed ? ', updating' : ''}`}
      testID="route-profile"
      {...responder.panHandlers}
    >
      {paths !== null && (
        <Svg width={width} height={PROFILE_HEIGHT} pointerEvents="none">
          <Path d={paths.area} fill={palette.ochre} fillOpacity={0.16} />
          <Path
            d={paths.line}
            stroke={palette.ochre}
            strokeWidth={2}
            fill="none"
            strokeLinejoin="round"
          />
          {cursorX !== null && (
            <Line
              x1={cursorX}
              x2={cursorX}
              y1={0}
              y2={PROFILE_HEIGHT}
              stroke={t.ink}
              strokeWidth={1.5}
            />
          )}
        </Svg>
      )}
      <Text
        style={[styles.edge, styles.max, { color: t.inkMuted, backgroundColor: t.surface }]}
        pointerEvents="none"
      >
        {top}
      </Text>
      <Text
        style={[styles.edge, styles.min, { color: t.inkMuted, backgroundColor: t.surface }]}
        pointerEvents="none"
      >
        {bottom}
      </Text>
      {scrub !== null && (
        <View
          style={[styles.readout, { backgroundColor: t.surface, borderColor: t.outlineVariant }]}
          pointerEvents="none"
          testID="route-profile-readout"
        >
          <Text style={[styles.readoutText, { color: t.ink }]} accessibilityLiveRegion="polite">
            {`${compactDistance(scrub.distanceM, units)} · ${formatElevation(scrub.elevationM, units)} · ${formatGrade(scrub.gradePct)}`}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { height: PROFILE_HEIGHT, width: '100%' },
  dimmed: { opacity: 0.45 },
  // On a paper chip, so a label never sits illegibly on the line.
  edge: {
    position: 'absolute',
    left: 0,
    paddingHorizontal: 3,
    borderRadius: 4,
    overflow: 'hidden',
    fontSize: 10.5,
    lineHeight: 13,
    fontWeight: '700',
  },
  max: { top: 0 },
  min: { bottom: 0 },
  readout: {
    position: 'absolute',
    top: 0,
    alignSelf: 'center',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  readoutText: { fontSize: 12, lineHeight: 16, fontWeight: '700' },
});
