import { sampleIndexAt, type ChartSeries } from '@core/geo/track';
import type { StatTile } from '@core/library/trailViewText';
import type { TrackNote } from '@core/models';
import { formatDistance, formatElevation } from '@state/formatters';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Image, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { NoteNumberBadge } from '../components/NoteNumberBadge';
import { JumpChips, type JumpMark } from './JumpChips';
import { StatTiles } from './StatTiles';
import { TrailChart } from './TrailChart';

interface Props {
  tiles: readonly StatTile[];
  /** The compact elevation chart (null while computing / without altitude). */
  series: ChartSeries | null;
  cursorDistanceM: number | null;
  onScrub: (distanceM: number) => void;
  marks: readonly JumpMark[];
  onJump: (distanceM: number) => void;
  /** Notes in trail order (numbered 1..N). */
  notes: readonly TrackNote[];
  onOpenNote: (noteId: string) => void;
}

/**
 * Overview tab (#511, board C2): the stat tiles, a compact elevation chart
 * to drag (it moves the map marker), the Start/Steepest/Summit/End chips and
 * the photos & waypoints strip.
 */
export function OverviewTab({
  tiles,
  series,
  cursorDistanceM,
  onScrub,
  marks,
  onJump,
  notes,
  onOpenNote,
}: Props) {
  const t = useSchemeTokens();
  return (
    <View testID="trail-overview">
      <StatTiles tiles={tiles} style={styles.grid} />

      <View style={styles.block}>
        {series?.elevation && (
          <TrailChart
            title="Elevation"
            valueText={
              cursorDistanceM === null
                ? 'drag to explore'
                : formatElevation(series.elevation[sampleIndexAt(series, cursorDistanceM)] ?? 0)
            }
            distances={series.distances}
            totalM={series.totalM}
            values={series.elevation}
            color={palette.ochre}
            area
            plotHeight={84}
            cursorDistanceM={cursorDistanceM}
            onScrub={onScrub}
            testID="overview-elevation"
          />
        )}
        <JumpChips marks={marks} cursorDistanceM={cursorDistanceM} onJump={onJump} />
      </View>

      <Text style={[styles.heading, { color: t.ink }]}>Photos and waypoints</Text>
      {notes.length === 0 ? (
        <Text variant="bodySmall" style={[styles.empty, { color: t.inkMuted }]}>
          None yet. Move the cursor to a spot, then add a note with a photo in the Timeline.
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
  grid: { paddingHorizontal: 16, paddingTop: 14 },
  block: { paddingHorizontal: 16, paddingTop: 14, gap: 10 },
  heading: { fontSize: 15, fontWeight: '800', paddingHorizontal: 16, paddingTop: 18 },
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
