import { formatLatLng } from '@core/geo/formatCoords';
import { waypointIconLabel } from '@core/library/waypointIcons';
import type { WaypointIcon } from '@core/models';
import { useState } from 'react';
import { Image, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Icon, IconButton, Surface, Text, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { InukshukGlyph } from '@ui/components/InukshukGlyph';
import { HoldButton } from './HoldButton';
import { mciGlyph } from './waypointGlyph';

export interface ViewableWaypoint {
  label: string;
  latitude: number;
  longitude: number;
  note?: string;
  photoUri?: string;
  /** Chosen pin icon (#350); absent = the default pin. */
  icon?: WaypointIcon;
}

interface Props {
  waypoint: ViewableWaypoint | null;
  onCopyCoords: () => void;
  onCopyNote: () => void;
  onSharePhoto: () => void;
  onEdit: () => void;
  /** Delete the waypoint — fired only after a completed hold (or a screen-reader action). */
  onDelete: () => void;
  onClose: () => void;
  /**
   * Floating above another bottom sheet (the recording panel, #505): every
   * corner is rounded so the card reads as its own layer, not a strip glued
   * onto the panel's rounded top.
   */
  floating?: boolean;
}

/**
 * The tapped waypoint, at a glance (#505): its note (whole, scrolling when
 * long) and photo straight away, with Edit and a hold-to-delete next to the
 * icon — no detour through the editor just to read or remove a pin.
 *
 * A bottom card (like TrailInspectPanel), NOT a Portal dialog — tapping a pin
 * must never arm the #108 invisible-overlay soft-lock, and a card keeps the
 * map visible while reading. Delete is a 0.8 s hold with a filling ring
 * (HoldButton, like Stop): a stray tap can't remove a pin, and there is no
 * confirm dialog to hide behind other chrome.
 */
export function WaypointViewerCard({
  waypoint,
  onCopyCoords,
  onCopyNote,
  onSharePhoto,
  onEdit,
  onDelete,
  onClose,
  floating = false,
}: Props) {
  const theme = useTheme();
  const [photoOpen, setPhotoOpen] = useState(false);
  if (!waypoint) return null;
  // The same mark the pin draws, so the card and the map agree at a glance.
  const glyph = mciGlyph(waypoint.icon);
  const note = waypoint.note?.trim() ?? '';
  const muted = theme.colors.onSurfaceVariant;
  return (
    <Surface style={[styles.card, floating && styles.floating]} elevation={4}>
      <View style={styles.header}>
        <View
          style={styles.icon}
          accessible
          accessibilityLabel={`${waypointIconLabel(waypoint.icon)} icon`}
        >
          {glyph === null ? (
            <InukshukGlyph size={22} frame="square" tone="mono" color={muted} />
          ) : (
            <Icon source={glyph} size={22} color={muted} />
          )}
        </View>
        <Text
          variant="titleMedium"
          numberOfLines={1}
          style={styles.title}
          accessibilityRole="header"
        >
          {waypoint.label}
        </Text>
        <IconButton
          icon="pencil-outline"
          size={20}
          onPress={onEdit}
          accessibilityLabel="Edit waypoint"
        />
        <HoldButton
          size={40}
          onConfirm={onDelete}
          accessibilityLabel="Delete waypoint"
          accessibilityHint="Press and hold to delete"
          accessibilityConfirmAction={{ name: 'delete', label: 'Delete waypoint' }}
          trackColor={theme.colors.outlineVariant}
          fillColor={theme.colors.error}
          background="transparent"
          style={styles.delete}
        >
          <Icon source="trash-can-outline" size={20} color={theme.colors.error} />
        </HoldButton>
        <IconButton icon="close" size={20} onPress={onClose} accessibilityLabel="Close waypoint" />
      </View>

      {note !== '' && (
        <View style={styles.noteRow}>
          <ScrollView style={styles.noteScroll} nestedScrollEnabled>
            <Text variant="bodyMedium" selectable testID="waypoint-note">
              {note}
            </Text>
          </ScrollView>
          <IconButton
            icon="content-copy"
            size={16}
            onPress={onCopyNote}
            accessibilityLabel="Copy note"
            style={styles.tight}
          />
        </View>
      )}

      {waypoint.photoUri !== undefined && (
        <View style={styles.photos}>
          <Pressable
            onPress={() => setPhotoOpen(true)}
            accessibilityRole="imagebutton"
            accessibilityLabel="View photo"
          >
            <Image source={{ uri: waypoint.photoUri }} style={styles.thumb} />
          </Pressable>
        </View>
      )}

      {note === '' && waypoint.photoUri === undefined && (
        <Text variant="bodySmall" style={[styles.empty, { color: muted }]}>
          No note or photo yet — tap the pencil to add one.
        </Text>
      )}

      <View style={styles.coordsRow}>
        <Text variant="bodySmall" style={[styles.grow, { color: muted }]} selectable>
          {formatLatLng(waypoint.latitude, waypoint.longitude)}
        </Text>
        <IconButton
          icon="content-copy"
          size={16}
          onPress={onCopyCoords}
          accessibilityLabel="Copy coordinates"
          style={styles.tight}
        />
      </View>

      {waypoint.photoUri !== undefined && (
        <PhotoViewer
          uri={waypoint.photoUri}
          visible={photoOpen}
          onShare={onSharePhoto}
          onClose={() => setPhotoOpen(false)}
        />
      )}
    </Surface>
  );
}

/**
 * The photo, full screen. A plain RN Modal (its own native window, so it sits
 * above every sheet on both platforms) rather than a Paper Portal; tap
 * anywhere or Back to close.
 */
function PhotoViewer({
  uri,
  visible,
  onShare,
  onClose,
}: {
  uri: string;
  visible: boolean;
  onShare: () => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <Pressable
        style={styles.viewer}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close photo"
      >
        <Image
          source={{ uri }}
          style={styles.full}
          resizeMode="contain"
          accessibilityIgnoresInvertColors
        />
      </Pressable>
      <View style={[styles.viewerBar, { top: insets.top + 8 }]} pointerEvents="box-none">
        <Button mode="contained-tonal" icon="share-variant" onPress={onShare}>
          Share
        </Button>
        <IconButton
          icon="close"
          mode="contained-tonal"
          onPress={onClose}
          accessibilityLabel="Close photo viewer"
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  card: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
  },
  floating: { borderRadius: 16 },
  header: { flexDirection: 'row', alignItems: 'center' },
  icon: { marginRight: 10 },
  title: { flex: 1 },
  delete: { marginHorizontal: 4 },
  noteRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 4, marginTop: 2 },
  // Long notes scroll inside the card instead of pushing it up the screen.
  noteScroll: { flex: 1, maxHeight: 168 },
  tight: { margin: 0 },
  photos: { flexDirection: 'row', gap: 8, marginTop: 8 },
  thumb: { width: 72, height: 72, borderRadius: 10 },
  empty: { marginTop: 2 },
  coordsRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  grow: { flex: 1 },
  viewer: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  full: { width: '100%', height: '100%' },
  viewerBar: {
    position: 'absolute',
    left: 16,
    right: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
});
