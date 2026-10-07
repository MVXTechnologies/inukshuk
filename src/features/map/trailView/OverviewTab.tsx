import { formatClockTime } from '@core/format';
import { sampleIndexAt, type ChartSeries } from '@core/geo/track';
import type { StatTile } from '@core/library/trailViewText';
import type { TrackNote } from '@core/models';
import type { PhotoOnAxis } from '@core/photos/axis';
import { isNotePhoto } from '@core/photos/model';
import { formatDistance, formatElevation } from '@state/formatters';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useMemo } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Icon, Text } from 'react-native-paper';
import { NoteNumberBadge } from '../components/NoteNumberBadge';
import { photoLabel } from '../../photos/photoText';
import { photoFileUri } from '../../photos/photoUri';
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
  /**
   * Trail photos (#587, own + note photos), time order, on the view's axis.
   * Hidden ones are listed too (dimmed), so they can be shown again.
   */
  photos?: readonly PhotoOnAxis[];
  onOpenPhoto?: (photoId: string) => void;
  /** "Add photos"; absent while photos cannot be added. */
  onAddPhotos?: () => void;
  /** Why photos can't be added or changed (newer version, unreadable), if so. */
  photoNotice?: string | null;
}

type StripItem =
  { kind: 'photo'; at: PhotoOnAxis; n: number } | { kind: 'note'; note: TrackNote; n: number };

/**
 * Overview tab (#511, board C2): the stat tiles, a compact elevation chart
 * to drag (it moves the map marker), the Start/Steepest/Summit/End chips and
 * the photos & waypoints strip — trail photos (#587) and notes, in trail
 * order. A note's photo rides its note card, not a second card.
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
  photos = [],
  onOpenPhoto,
  onAddPhotos,
  photoNotice,
}: Props) {
  const t = useSchemeTokens();
  const own = useMemo(() => photos.filter((p) => !isNotePhoto(p.photo)), [photos]);
  const items = useMemo((): StripItem[] => {
    const list: StripItem[] = [
      ...own.map((at, i) => ({ kind: 'photo' as const, at, n: i + 1 })),
      ...notes.map((note, i) => ({ kind: 'note' as const, note, n: i + 1 })),
    ];
    const where = (it: StripItem) => (it.kind === 'photo' ? it.at.distanceM : it.note.distanceM);
    return list.sort((a, b) => where(a) - where(b));
  }, [own, notes]);
  // Small ticks on the compact chart where the (shown) photos are.
  const photoTicks = useMemo(
    () => own.filter((p) => !p.photo.hidden).map((p) => p.distanceM),
    [own],
  );

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
            dots={photoTicks}
            testID="overview-elevation"
          />
        )}
        <JumpChips marks={marks} cursorDistanceM={cursorDistanceM} onJump={onJump} />
      </View>

      <View style={styles.headingRow}>
        <Text style={[styles.heading, { color: t.ink }]}>
          {items.length > 0 ? `Photos and waypoints · ${items.length}` : 'Photos and waypoints'}
        </Text>
        {onAddPhotos && (
          <Button
            compact
            icon="image-plus"
            onPress={onAddPhotos}
            accessibilityLabel="Add photos"
            testID="add-photos"
          >
            Add photos
          </Button>
        )}
      </View>
      {photoNotice ? (
        <Text
          variant="bodySmall"
          style={[styles.empty, { color: t.inkVariant }]}
          testID="photo-notice"
        >
          {photoNotice}
        </Text>
      ) : null}
      {items.length === 0 ? (
        <Text variant="bodySmall" style={[styles.empty, { color: t.inkMuted }]}>
          {onAddPhotos
            ? 'None yet. Add photos from your library, or move the cursor to a spot and add a note in the Timeline.'
            : 'None yet. Move the cursor to a spot, then add a note with a photo in the Timeline.'}
        </Text>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.strip}
          testID="trail-photo-strip"
        >
          {items.map((it) =>
            it.kind === 'photo' ? (
              <Pressable
                key={`p-${it.at.photo.id}`}
                onPress={() => onOpenPhoto?.(it.at.photo.id)}
                accessibilityRole="button"
                accessibilityLabel={`Photo ${it.n} of ${own.length}: ${photoLabel(it.at.photo, it.n)}${
                  it.at.photo.hidden ? ' (hidden from the map)' : ''
                }`}
                style={[
                  styles.card,
                  { backgroundColor: t.elevation.level2, borderColor: t.outlineVariant },
                ]}
              >
                <Image
                  source={{ uri: photoFileUri(it.at.photo.thumb) }}
                  style={[styles.photo, it.at.photo.hidden && styles.dimmed]}
                />
                {it.at.photo.hidden && (
                  <View style={[styles.hiddenBadge, { backgroundColor: t.surface }]}>
                    <Icon source="eye-off-outline" size={14} color={t.inkMuted} />
                  </View>
                )}
                <View style={styles.cardBody}>
                  <Text style={[styles.cardText, { color: t.ink }]} numberOfLines={1}>
                    {it.at.photo.caption?.trim() || `Photo ${it.n}`}
                  </Text>
                </View>
                <Text style={[styles.cardWhere, { color: t.inkMuted }]} numberOfLines={1}>
                  {[
                    formatDistance(it.at.distanceM),
                    it.at.photo.takenAt !== undefined ? formatClockTime(it.at.photo.takenAt) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              </Pressable>
            ) : (
              <Pressable
                key={`n-${it.note.id}`}
                onPress={() => onOpenNote(it.note.id)}
                accessibilityRole="button"
                accessibilityLabel={`Note ${it.n}: ${it.note.text}`}
                style={[
                  styles.card,
                  { backgroundColor: t.elevation.level2, borderColor: t.outlineVariant },
                ]}
              >
                {it.note.photoUri ? (
                  <Image source={{ uri: it.note.photoUri }} style={styles.photo} />
                ) : (
                  <View
                    style={[styles.photo, styles.noPhoto, { backgroundColor: t.surfaceVariant }]}
                  >
                    <Icon source="note-text-outline" size={26} color={t.inkMuted} />
                  </View>
                )}
                <View style={styles.cardBody}>
                  <NoteNumberBadge num={it.n} />
                  <Text style={[styles.cardText, { color: t.ink }]} numberOfLines={1}>
                    {it.note.text}
                  </Text>
                </View>
                <Text style={[styles.cardWhere, { color: t.inkMuted }]}>
                  {formatDistance(it.note.distanceM)}
                </Text>
              </Pressable>
            ),
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { paddingHorizontal: 16, paddingTop: 14 },
  block: { paddingHorizontal: 16, paddingTop: 14, gap: 10 },
  headingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 16,
    paddingRight: 8,
    paddingTop: 12,
    minHeight: 44,
  },
  heading: { fontSize: 15, fontWeight: '800' },
  empty: { paddingHorizontal: 16, paddingTop: 6 },
  strip: { gap: 10, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 4 },
  card: { width: 132, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  photo: { width: 132, height: 88 },
  dimmed: { opacity: 0.45 },
  hiddenBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    borderRadius: 10,
    padding: 3,
  },
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
