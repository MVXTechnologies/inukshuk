import type { TimelineEvent, TimelineEventKind } from '@core/geo/track';
import type { TimelineText } from '@core/library/trailViewText';
import { palette, type SchemeTokens } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { Button, Icon, IconButton, Text, useTheme } from 'react-native-paper';
import { HoldButton } from '../components/HoldButton';

export interface TimelineItem {
  event: TimelineEvent;
  text: TimelineText;
}

interface Props {
  items: readonly TimelineItem[];
  /** The cursor's distance: the item under it is highlighted. */
  selectedDistanceM: number | null;
  onSelect: (event: TimelineEvent) => void;
  /** Still computing (first open of a long trail). */
  loading?: boolean;
  /** Where "Add a note here" anchors ("2.73 km"), or null with no cursor yet. */
  addAt: string | null;
  onAddNote: () => void;
  onEditNote: (noteId: string) => void;
  /** Fired only after a completed hold (or a screen-reader action). */
  onDeleteNote: (noteId: string) => void;
  onViewPhoto: (uri: string) => void;
}

function dotColor(kind: TimelineEventKind, t: SchemeTokens): string {
  switch (kind) {
    case 'start':
    case 'finish':
      return t.inkVariant;
    case 'note':
      return palette.sageDeep; // the note badges' green family
    case 'steep':
      return t.explore.trail;
    case 'summit':
      return palette.ochre;
    case 'stop':
    case 'pause':
      return t.status.pausedInk;
  }
}

/**
 * Timeline tab (#511, board D): the outing as a vertical timeline. Each
 * event is a button — tapping it moves the profile cursor and the map
 * marker to that spot.
 */
export function TimelineTab({
  items,
  selectedDistanceM,
  onSelect,
  loading,
  addAt,
  onAddNote,
  onEditNote,
  onDeleteNote,
  onViewPhoto,
}: Props) {
  const t = useSchemeTokens();
  const theme = useTheme();
  const add = (
    <View style={styles.addRow}>
      <Button
        mode="contained-tonal"
        icon="map-marker-plus"
        disabled={addAt === null}
        onPress={onAddNote}
        compact
      >
        {addAt === null ? 'Add a note here' : `Add a note at ${addAt}`}
      </Button>
      {addAt === null && (
        <Text variant="bodySmall" style={[styles.addHint, { color: t.inkMuted }]}>
          Move the cursor first: drag a chart, tap a chip or an event.
        </Text>
      )}
    </View>
  );
  if (loading) {
    return (
      <View>
        {add}
        <Text variant="bodySmall" style={[styles.pad, { color: t.inkMuted }]}>
          Reading the outing…
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.list} testID="trail-timeline">
      {add}
      {items.map(({ event, text }, i) => {
        const last = i === items.length - 1;
        const on =
          selectedDistanceM !== null && Math.abs(event.at.distanceM - selectedDistanceM) < 1;
        return (
          <Pressable
            key={`${event.kind}-${i}`}
            onPress={() => onSelect(event)}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`${text.time ? `${text.time}, ` : ''}${text.title}. ${text.sub}`}
            accessibilityHint="Shows this point on the map and the profile"
            style={({ pressed }) => [
              styles.row,
              (on || pressed) && { backgroundColor: t.elevation.level2 },
            ]}
          >
            <View style={styles.rail}>
              <View
                style={[
                  styles.dot,
                  { backgroundColor: dotColor(event.kind, t) },
                  on && { borderColor: t.ink, borderWidth: 2 },
                ]}
              />
              {!last && <View style={[styles.line, { backgroundColor: t.outlineVariant }]} />}
            </View>
            <View style={styles.body}>
              <View style={styles.head}>
                {text.time !== null && (
                  <Text style={[styles.time, { color: t.inkMuted }]}>{text.time}</Text>
                )}
                <Text style={[styles.title, { color: t.ink }]} numberOfLines={2}>
                  {text.title}
                </Text>
              </View>
              {text.sub !== '' && (
                <Text style={[styles.sub, { color: t.inkVariant }]} numberOfLines={3}>
                  {text.sub}
                </Text>
              )}
              {event.photoUri ? (
                <Pressable
                  onPress={() => onViewPhoto(event.photoUri ?? '')}
                  accessibilityRole="imagebutton"
                  accessibilityLabel="View photo"
                >
                  <Image source={{ uri: event.photoUri }} style={styles.photo} />
                </Pressable>
              ) : null}
            </View>
            {event.kind === 'note' && event.noteId !== undefined && (
              <View style={styles.noteActions}>
                <IconButton
                  icon="pencil-outline"
                  size={20}
                  onPress={() => onEditNote(event.noteId ?? '')}
                  accessibilityLabel={`Edit note ${event.noteNum ?? ''}`.trim()}
                  style={styles.tight}
                />
                <HoldButton
                  size={36}
                  onConfirm={() => onDeleteNote(event.noteId ?? '')}
                  accessibilityLabel={`Delete note ${event.noteNum ?? ''}`.trim()}
                  accessibilityHint="Press and hold to delete"
                  accessibilityConfirmAction={{ name: 'delete', label: 'Delete note' }}
                  trackColor={t.outlineVariant}
                  fillColor={theme.colors.error}
                  background="transparent"
                >
                  <Icon source="trash-can-outline" size={19} color={theme.colors.error} />
                </HoldButton>
              </View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  pad: { padding: 16 },
  addRow: { paddingHorizontal: 16, paddingBottom: 12, gap: 4, alignItems: 'flex-start' },
  addHint: { paddingLeft: 4 },
  noteActions: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start' },
  tight: { margin: 0 },
  list: { paddingTop: 10, paddingBottom: 4 },
  row: { flexDirection: 'row', gap: 12, paddingHorizontal: 16 },
  rail: { width: 22, alignItems: 'center' },
  dot: { width: 14, height: 14, borderRadius: 7, marginTop: 4 },
  line: { flex: 1, width: 2, marginTop: 2 },
  body: { flex: 1, paddingBottom: 18, gap: 3 },
  head: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  time: { fontSize: 13, fontWeight: '800', minWidth: 46 },
  title: { flex: 1, fontSize: 16, fontWeight: '800' },
  sub: { fontSize: 13.5 },
  photo: { width: 150, height: 90, borderRadius: 10, marginTop: 4 },
});
