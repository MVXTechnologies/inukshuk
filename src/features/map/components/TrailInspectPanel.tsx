import type { TrackPointAt } from '@core/geo/track';
import type { TrackPoint, TrackSummary } from '@core/models';
import { StyleSheet, View } from 'react-native';
import { IconButton, Surface, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ElevationProfile } from '../../library/components/ElevationProfile';

interface Props {
  track: TrackSummary;
  points: readonly TrackPoint[];
  onClose: () => void;
  /** Scrub position along the profile (drives the on-map marker). */
  onScrub: (at: TrackPointAt | null) => void;
}

/** Bottom sheet showing the inspected trail's name + scrubbable elevation profile. */
export function TrailInspectPanel({ track, points, onClose, onScrub }: Props) {
  const insets = useSafeAreaInsets();
  return (
    <Surface style={[styles.inspectPanel, { paddingBottom: insets.bottom + 8 }]} elevation={4}>
      <View style={styles.inspectHeader}>
        <Text variant="titleSmall" numberOfLines={1} style={styles.inspectTitle}>
          {track.name}
        </Text>
        <IconButton
          icon="close"
          size={20}
          onPress={onClose}
          accessibilityLabel="Close trail inspector"
        />
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
    paddingTop: 4,
  },
  inspectHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 14,
  },
  inspectTitle: { flexShrink: 1, fontWeight: '700' },
});
