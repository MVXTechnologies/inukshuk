import type { StatTile } from '@core/library/trailViewText';
import type { TrackNote } from '@core/models';
import { formatDistance } from '@state/formatters';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Image, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { NoteNumberBadge } from '../components/NoteNumberBadge';

interface Props {
  tiles: readonly StatTile[];
  /** Notes in trail order (numbered 1..N). */
  notes: readonly TrackNote[];
  onOpenNote: (noteId: string) => void;
}

/** Overview tab (#511): the stat tiles, then the photos & waypoints strip. */
export function OverviewTab({ tiles, notes, onOpenNote }: Props) {
  const t = useSchemeTokens();
  return (
    <View testID="trail-overview">
      <View style={styles.grid}>
        {tiles.map((tile) => (
          <View
            key={tile.label}
            style={styles.tile}
            accessible
            accessibilityLabel={`${tile.label} ${tile.value}${tile.sub ? `, ${tile.sub}` : ''}`}
          >
            <Text style={[styles.value, { color: t.ink }]} numberOfLines={1} adjustsFontSizeToFit>
              {tile.value}
            </Text>
            {tile.sub ? (
              <Text style={[styles.sub, { color: t.inkVariant }]} numberOfLines={1}>
                {tile.sub}
              </Text>
            ) : null}
            <Text style={[styles.label, { color: t.inkMuted }]} numberOfLines={1}>
              {tile.label}
            </Text>
          </View>
        ))}
      </View>

      <Text style={[styles.heading, { color: t.ink }]}>Photos and waypoints</Text>
      {notes.length === 0 ? (
        <Text variant="bodySmall" style={[styles.empty, { color: t.inkMuted }]}>
          None yet. Scrub the profile to a spot, then add a note with a photo in the Notes tab.
        </Text>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.strip}
          testID="trail-photo-strip"
        >
          {notes.map((n, i) => (
            <Pressable
              key={n.id}
              onPress={() => onOpenNote(n.id)}
              accessibilityRole="button"
              accessibilityLabel={`Note ${i + 1}: ${n.text}`}
              style={[
                styles.card,
                { backgroundColor: t.elevation.level2, borderColor: t.outlineVariant },
              ]}
            >
              {n.photoUri ? (
                <Image source={{ uri: n.photoUri }} style={styles.photo} />
              ) : (
                <View style={[styles.photo, styles.noPhoto, { backgroundColor: t.surfaceVariant }]}>
                  <Icon source="note-text-outline" size={26} color={t.inkMuted} />
                </View>
              )}
              <View style={styles.cardBody}>
                <NoteNumberBadge num={i + 1} />
                <Text style={[styles.cardText, { color: t.ink }]} numberOfLines={1}>
                  {n.text}
                </Text>
              </View>
              <Text style={[styles.cardWhere, { color: t.inkMuted }]}>
                {formatDistance(n.distanceM)}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 16,
    paddingTop: 14,
    rowGap: 14,
  },
  tile: { width: '33.33%', paddingRight: 8 },
  value: { fontSize: 18, fontWeight: '800' },
  sub: { fontSize: 12 },
  label: { fontSize: 12, marginTop: 1 },
  heading: { fontSize: 15, fontWeight: '800', paddingHorizontal: 16, paddingTop: 20 },
  empty: { paddingHorizontal: 16, paddingTop: 6 },
  strip: { gap: 10, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 4 },
  card: { width: 132, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  photo: { width: 132, height: 88 },
  noPhoto: { alignItems: 'center', justifyContent: 'center' },
  cardBody: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingTop: 6,
  },
  cardText: { flex: 1, fontSize: 13, fontWeight: '700' },
  cardWhere: { fontSize: 11.5, paddingHorizontal: 8, paddingBottom: 8, paddingTop: 2 },
});
