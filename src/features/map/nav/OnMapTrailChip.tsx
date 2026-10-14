import { onMapChipTrail, type OnMapTrailRef } from '@core/library/onMapTrail';
import { useLibraryStore } from '@state/libraryStore';
import { useNavigationStore } from '@state/navigationStore';
import { useOnMapTrailStore } from '@state/onMapTrailStore';
import { palette } from '@ui/tokens';
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { Icon, Text, TouchableRipple } from 'react-native-paper';

import { weatherChrome as wc } from '../weather/weatherChrome';

/**
 * The trail shown with "On map" (#710), or null: none without one, and never
 * while following it (#678). Subscribes to the name only, so a library edit
 * elsewhere does not re-render the map.
 */
export function useOnMapTrailChip(): OnMapTrailRef | null {
  const trackId = useOnMapTrailStore((s) => s.trackId);
  const followingId = useNavigationStore((s) => s.following?.trackId ?? null);
  const name = useLibraryStore((s) =>
    trackId === null ? null : (s.tracks.find((t) => t.id === trackId)?.name ?? null),
  );
  if (trackId === null || name === null) return null;
  return onMapChipTrail(trackId, [{ id: trackId, name }], followingId);
}

/**
 * The chip of a trail shown with the trail view's "On map" (#710): its name
 * and the ✕ that takes it off the map (the map's previous trails come back).
 * Tapping the name reopens the trail. The long-trail pill's idea (name + ✕,
 * `ShownTrailPill`) in the destination chip's row and look: the fixed dark
 * slab of the map's floating chrome, the same in both themes, with the
 * trail's orange route mark. Maestro keys on the ✕'s testID
 * `onmap-trail-close` (a11y label "Close trail on map").
 */
export function OnMapTrailChip({ trail }: { trail: OnMapTrailRef }) {
  const router = useRouter();
  const close = useOnMapTrailStore((s) => s.close);
  return (
    <View style={styles.chip} testID="onmap-trail-chip">
      <TouchableRipple
        onPress={() => router.push(`/trail3d/${trail.id}`)}
        style={styles.body}
        accessibilityRole="button"
        accessibilityLabel={`Open trail ${trail.name}`}
        borderless
      >
        <View style={styles.row}>
          <Icon source="map-marker-path" size={16} color={palette.route} />
          <Text style={styles.text} numberOfLines={1}>
            {trail.name}
          </Text>
        </View>
      </TouchableRipple>
      <TouchableRipple
        testID="onmap-trail-close"
        onPress={close}
        style={styles.clear}
        accessibilityLabel="Close trail on map"
        accessibilityRole="button"
        borderless
      >
        <Icon source="close" size={15} color={wc.inkMuted} />
      </TouchableRipple>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    maxWidth: '100%',
    backgroundColor: wc.panel,
    borderRadius: 15,
    paddingLeft: 4,
    paddingRight: 4,
  },
  // The destination chip's height (5 + 25 + 5): the name is the tap target.
  body: { flexShrink: 1, borderRadius: 12, paddingLeft: 6, paddingRight: 2, paddingVertical: 9 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  text: { flexShrink: 1, fontSize: 13, lineHeight: 17, fontWeight: '700', color: wc.ink },
  clear: { borderRadius: 12, padding: 5 },
});
