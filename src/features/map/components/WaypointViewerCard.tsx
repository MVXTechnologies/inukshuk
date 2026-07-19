import { formatLatLng } from '@core/geo/formatCoords';
import { Image, StyleSheet, View } from 'react-native';
import { Button, IconButton, Surface, Text } from 'react-native-paper';

export interface ViewableWaypoint {
  label: string;
  latitude: number;
  longitude: number;
  note?: string;
  photoUri?: string;
}

interface Props {
  waypoint: ViewableWaypoint | null;
  onCopyCoords: () => void;
  onCopyNote: () => void;
  onSharePhoto: () => void;
  onEdit: () => void;
  onClose: () => void;
}

/**
 * Read-only viewer for a tapped waypoint pin: coordinates, note and photo at
 * a glance, each with its own copy/share action, and an explicit Edit step
 * into the editor dialog. A bottom card (like TrailInspectPanel), NOT a
 * Portal dialog — tapping a pin must never arm the #108 invisible-overlay
 * soft-lock, and a card keeps the map visible while reading.
 */
export function WaypointViewerCard({
  waypoint,
  onCopyCoords,
  onCopyNote,
  onSharePhoto,
  onEdit,
  onClose,
}: Props) {
  if (!waypoint) return null;
  return (
    <Surface style={styles.card} elevation={4}>
      <View style={styles.header}>
        <Text variant="titleMedium" numberOfLines={1} style={styles.title}>
          {waypoint.label}
        </Text>
        <IconButton
          icon="pencil-outline"
          size={20}
          onPress={onEdit}
          accessibilityLabel="Edit waypoint"
        />
        <IconButton icon="close" size={20} onPress={onClose} accessibilityLabel="Close waypoint" />
      </View>
      <View style={styles.row}>
        <Text variant="bodyMedium" style={styles.grow} selectable>
          {formatLatLng(waypoint.latitude, waypoint.longitude)}
        </Text>
        <Button compact icon="content-copy" onPress={onCopyCoords}>
          Copy
        </Button>
      </View>
      {waypoint.note !== undefined && waypoint.note.trim() !== '' && (
        <View style={styles.row}>
          <Text variant="bodyMedium" style={styles.grow} numberOfLines={3}>
            {waypoint.note}
          </Text>
          <Button compact icon="content-copy" onPress={onCopyNote} accessibilityLabel="Copy note">
            Copy
          </Button>
        </View>
      )}
      {waypoint.photoUri !== undefined && (
        <View style={styles.row}>
          <Image source={{ uri: waypoint.photoUri }} style={styles.photo} />
          <Button
            compact
            icon="share-variant"
            onPress={onSharePhoto}
            accessibilityLabel="Share photo"
          >
            Share
          </Button>
        </View>
      )}
    </Surface>
  );
}

const styles = StyleSheet.create({
  card: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 12,
  },
  header: { flexDirection: 'row', alignItems: 'center' },
  title: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },
  grow: { flex: 1 },
  photo: { width: 56, height: 56, borderRadius: 8 },
});
