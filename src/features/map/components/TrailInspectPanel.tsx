import {
  scrubPointToTrackAt,
  trackPointsProfile,
  type ProfileScrubPoint,
} from '@core/draw/profile';
import type { Units } from '@core/format';
import { findElevationExtremes, trailTiming, type TrackPointAt } from '@core/geo/track';
import { overviewTiles } from '@core/library/trailViewText';
import type { TrackPoint, TrackSummary } from '@core/models';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useCallback, useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ProfileStrip } from '../../common/components/ProfileStrip';
import { StatTiles } from '../trailView/StatTiles';

interface Props {
  track: TrackSummary;
  points: readonly TrackPoint[];
  units: Units;
  onClose: () => void;
  /** Scrub position along the profile (drives the on-map marker). */
  onScrub: (at: TrackPointAt | null) => void;
  /** Opens this trail in the full viewer (2D/3D, notes, PDF export, trim). */
  onView: () => void;
  /** A route drawn on the map (#502): reopen it in the drawing tool. */
  onEditRoute?: () => void;
  /** Reports the panel's real laid-out height in dp, so the map's
   * select-trail camera fit can pad exactly above it instead of guessing. */
  onLayout?: (height: number) => void;
}

/**
 * Compact bottom sheet for the trail tapped on the map — recorded, imported
 * or drawn: its name, the trail view's first row of stat tiles (#511 C2), and
 * the drawing panel's elevation strip (#515), scrubbable to move the map
 * marker. "View" opens the full trail viewer; a drawn route also offers
 * "Edit route". A quick, map-side peek — editing lives elsewhere.
 *
 * Same chrome as the drawing panel: a plain themed View (never a Paper
 * Surface, which collapses absolutely-positioned flex columns on iOS).
 */
export function TrailInspectPanel({
  track,
  points,
  units,
  onClose,
  onScrub,
  onView,
  onEditRoute,
  onLayout,
}: Props) {
  const insets = useSafeAreaInsets();
  const t = useSchemeTokens();

  const profile = useMemo(() => trackPointsProfile(points), [points]);
  const tiles = useMemo(
    () =>
      overviewTiles(
        track.stats,
        trailTiming(track.stats, track.category),
        findElevationExtremes(points),
        units,
      ).slice(0, 3),
    [track.stats, track.category, points, units],
  );
  const scrub = useCallback(
    (point: ProfileScrubPoint | null) => onScrub(point ? scrubPointToTrackAt(point) : null),
    [onScrub],
  );
  const planned = track.plan !== undefined;

  return (
    <View
      style={[
        styles.panel,
        {
          paddingBottom: insets.bottom + 14,
          backgroundColor: t.surface,
          shadowColor: palette.shadow,
        },
      ]}
      onLayout={onLayout ? (e) => onLayout(e.nativeEvent.layout.height) : undefined}
      testID="trail-inspect-panel"
    >
      <View style={styles.titleRow}>
        <View style={styles.titleText}>
          <Text
            style={[styles.title, { color: t.ink }]}
            numberOfLines={1}
            accessibilityRole="header"
          >
            {track.name}
          </Text>
          {planned && (
            <Text style={[styles.caption, { color: t.inkMuted }]} numberOfLines={1}>
              Planned route
            </Text>
          )}
        </View>
        {planned && onEditRoute && (
          <HeaderButton icon="vector-polyline-edit" label="Edit route" onPress={onEditRoute} />
        )}
        <HeaderButton icon="open-in-new" label="View trail" onPress={onView} />
        <HeaderButton icon="close" label="Close trail inspector" onPress={onClose} />
      </View>

      <StatTiles tiles={tiles} testID="trail-inspect-tiles" />

      {profile ? (
        <ProfileStrip
          profile={profile}
          units={units}
          onScrub={scrub}
          testID="trail-inspect-profile"
        />
      ) : (
        <Text style={[styles.noElevation, { color: t.inkMuted }]}>No elevation data</Text>
      )}
    </View>
  );
}

function HeaderButton({
  icon,
  label,
  onPress,
}: {
  icon: string;
  label: string;
  onPress: () => void;
}) {
  const t = useSchemeTokens();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={styles.headerButton}
    >
      <Icon source={icon} size={22} color={t.inkMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // The drawing panel's sheet (DrawPanels `panel`): same radius, padding, shadow.
  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 18,
    paddingTop: 8,
    gap: 12,
    elevation: 8,
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: -2 },
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', minHeight: 40 },
  titleText: { flex: 1, minWidth: 0 },
  title: { fontSize: 15, lineHeight: 20, fontWeight: '800' },
  caption: { fontSize: 12, lineHeight: 16 },
  headerButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  noElevation: { fontSize: 13, paddingVertical: 8 },
});
