import type { TrackNote } from '@core/models';
import { formatDistance } from '@state/formatters';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { Button, IconButton, Text } from 'react-native-paper';
import { NoteNumberBadge } from '../components/NoteNumberBadge';

interface Props {
  /** Notes in trail order (numbered 1..N). */
  notes: readonly TrackNote[];
  /** A cursor is set on the profile: "Add note" anchors there. */
  canAdd: boolean;
  onAdd: () => void;
  /** Move the cursor/marker to the note. */
  onFocus: (note: TrackNote) => void;
  onViewPhoto: (uri: string) => void;
  onEdit: (note: TrackNote) => void;
  onDelete: (note: TrackNote) => void;
}

/** Notes tab (#511): the trail's notes and photos — add, edit, delete (unchanged behaviour). */
export function NotesTab({ notes, canAdd, onAdd, onFocus, onViewPhoto, onEdit, onDelete }: Props) {
  const t = useSchemeTokens();
  return (
    <View testID="trail-notes">
      <View style={styles.header}>
        <Text variant="titleSmall" style={[styles.title, { color: t.ink }]}>
          Notes ({notes.length})
        </Text>
        <Button compact icon="map-marker-plus" disabled={!canAdd} onPress={onAdd}>
          Add note
        </Button>
      </View>
      {notes.length === 0 ? (
        <Text variant="bodySmall" style={[styles.pad, { color: t.inkMuted }]}>
          Scrub the profile to a spot and tap “Add note”.
        </Text>
      ) : (
        notes.map((n, i) => (
          <View key={n.id} style={styles.row}>
            <View style={styles.badge}>
              <NoteNumberBadge num={i + 1} />
            </View>
            <Pressable style={styles.body} onPress={() => onFocus(n)}>
              <Text variant="bodyMedium" style={{ color: t.ink }}>
                {n.text}
              </Text>
              <Text variant="bodySmall" style={{ color: t.inkMuted }}>
                {formatDistance(n.distanceM)}
              </Text>
              {n.photoUri && (
                <Pressable
                  onPress={() => onViewPhoto(n.photoUri ?? '')}
                  accessibilityRole="imagebutton"
                  accessibilityLabel="View photo"
                >
                  <Image source={{ uri: n.photoUri }} style={styles.thumb} />
                </Pressable>
              )}
            </Pressable>
            <IconButton
              icon="pencil-outline"
              accessibilityLabel="Edit note"
              onPress={() => onEdit(n)}
            />
            <IconButton
              icon="trash-can-outline"
              accessibilityLabel="Delete note"
              onPress={() => onDelete(n)}
            />
          </View>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 16,
    paddingRight: 8,
    paddingTop: 8,
  },
  title: { fontWeight: '700' },
  pad: { paddingHorizontal: 16 },
  row: { flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 4 },
  badge: { marginRight: 12 },
  body: { flex: 1, paddingVertical: 8 },
  thumb: { width: 120, height: 90, borderRadius: 8, marginTop: 6 },
});
