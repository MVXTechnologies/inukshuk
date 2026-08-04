import type { TrackPointAt } from '@core/geo/track';
import type { TrackPoint, TrackSummary } from '@core/models';
import { IconButton, Surface, Text } from 'react-native-paper';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ElevationProfile } from '../../common/components/ElevationProfile';

interface Props {
  track: TrackSummary;
  points: readonly TrackPoint[];
  onClose: () => void;
  /** Scrub position along the profile (drives the on-map marker). */
  onScrub: (at: TrackPointAt | null) => void;
  /** Opens this trail in the full viewer (2D/3D, notes, PDF export, trim). */
  onView: () => void;
}

/**
 * Compact bottom sheet for the inspected trail: name + its scrubbable
 * elevation profile, and a "View" button opening the full trail viewer.
 * Trimming lives there now (Trail3DGLScreen) — this panel is a quick,
 * map-side peek, not a place to edit the trail.
 */
export function TrailInspectPanel({ track, points, onClose, onScrub, onView }: Props) {
  const insets = useSafeAreaInsets();

  return (
    <Surface style={[styles.inspectPanel, { paddingBottom: insets.bottom + 4 }]} elevation={4}>
      <View style={styles.inspectHeader}>
        <Text variant="titleSmall" numberOfLines={1} style={styles.inspectTitle}>
          {track.name}
        </Text>
        <View style={styles.headerActions}>
          <IconButton
            icon="open-in-new"
            size={20}
            onPress={onView}
            accessibilityLabel="View trail"
          />
          <IconButton
            icon="close"
            size={20}
            onPress={onClose}
            accessibilityLabel="Close trail inspector"
          />
        </View>
      </View>

      <ElevationProfile
        points={points}
        ascentM={track.stats.ascentM}
        descentM={track.stats.descentM}
        onScrub={onScrub}
      />
    </Surface>
  );
}

const styles = StyleSheet.create({
  inspectPanel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  inspectHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 14,
  },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
  inspectTitle: { flexShrink: 1, fontWeight: '700' },
});
