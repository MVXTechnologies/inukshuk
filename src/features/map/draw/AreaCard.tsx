import { areaSummaryLine } from '@core/library/areas';
import type { Units } from '@core/format';
import type { Area } from '@core/models';
import { useState } from 'react';
import { Image, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Icon, IconButton, Surface, Text, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { HoldButton } from '../components/HoldButton';

interface Props {
  area: Area;
  units: Units;
  onEdit: () => void;
  /** Fired only after a completed hold (or a screen-reader action). */
  onDelete: () => void;
  onClose: () => void;
  /** "+ Photo" straight from the card. */
  onAddPhoto: () => void;
  /** Share the area as a GeoJSON file. */
  onShare: () => void;
}

/**
 * A tapped area, at a glance (#503, board `Area.dc.html`): colour, name, its
 * size and perimeter, the note, photos (with "+ Photo") and tags — Edit and a
 * hold-to-delete beside the name, like the waypoint card (#505/#508). A
 * bottom card, never a Portal dialog: the map stays visible while reading.
 */
export function AreaCard({ area, units, onEdit, onDelete, onClose, onAddPhoto, onShare }: Props) {
  const theme = useTheme();
  const [viewing, setViewing] = useState<string | null>(null);
  const note = area.note?.trim() ?? '';
  const muted = theme.colors.onSurfaceVariant;
  const photos = area.photoUris ?? [];
  return (
    <Surface style={styles.card} elevation={4} testID="area-card">
      <View style={styles.header}>
        <View
          style={[styles.swatch, { backgroundColor: area.color }]}
          accessible
          accessibilityLabel="Area colour"
        />
        <Text
          variant="titleMedium"
          numberOfLines={1}
          style={styles.title}
          accessibilityRole="header"
        >
          {area.name}
        </Text>
        <IconButton
          icon="pencil-outline"
          size={20}
          onPress={onEdit}
          accessibilityLabel="Edit area"
        />
        <HoldButton
          size={40}
          onConfirm={onDelete}
          accessibilityLabel="Delete area"
          accessibilityHint="Press and hold to delete"
          accessibilityConfirmAction={{ name: 'delete', label: 'Delete area' }}
          trackColor={theme.colors.outlineVariant}
          fillColor={theme.colors.error}
          background="transparent"
          style={styles.delete}
        >
          <Icon source="trash-can-outline" size={20} color={theme.colors.error} />
        </HoldButton>
        <IconButton icon="close" size={20} onPress={onClose} accessibilityLabel="Close area" />
      </View>

      <Text variant="bodySmall" style={{ color: muted }} testID="area-card-summary">
        {areaSummaryLine(area.ring, units)}
      </Text>

      {note !== '' && (
        <ScrollView style={styles.noteScroll} nestedScrollEnabled>
          <Text variant="bodyMedium" selectable testID="area-note">
            {note}
          </Text>
        </ScrollView>
      )}

      <View style={styles.photos}>
        {photos.map((uri) => (
          <Pressable
            key={uri}
            onPress={() => setViewing(uri)}
            accessibilityRole="imagebutton"
            accessibilityLabel="View photo"
          >
            <Image source={{ uri }} style={styles.thumb} />
          </Pressable>
        ))}
        <Pressable
          onPress={onAddPhoto}
          accessibilityRole="button"
          accessibilityLabel="Add photo to area"
          style={[styles.addPhoto, { borderColor: theme.colors.outline }]}
        >
          <Text variant="labelMedium" style={{ color: muted }}>
            + Photo
          </Text>
        </Pressable>
      </View>

      {area.tags !== undefined && area.tags.length > 0 && (
        <View style={styles.tags}>
          {area.tags.map((tag) => (
            <View
              key={tag}
              style={[styles.tag, { backgroundColor: theme.colors.secondaryContainer }]}
            >
              <Text
                style={[styles.tagLabel, { color: theme.colors.onSecondaryContainer }]}
                numberOfLines={1}
              >
                {tag}
              </Text>
            </View>
          ))}
        </View>
      )}

      <View style={styles.footer}>
        <Button compact icon="share-variant" onPress={onShare}>
          Share GeoJSON
        </Button>
      </View>

      <PhotoModal uri={viewing} onClose={() => setViewing(null)} />
    </Surface>
  );
}

function PhotoModal({ uri, onClose }: { uri: string | null; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={uri !== null}
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
        {uri !== null && <Image source={{ uri }} style={styles.full} resizeMode="contain" />}
      </Pressable>
      <View style={[styles.viewerBar, { top: insets.top + 8 }]} pointerEvents="box-none">
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
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 18,
    paddingTop: 4,
    paddingBottom: 8,
    gap: 8,
  },
  header: { flexDirection: 'row', alignItems: 'center' },
  swatch: { width: 18, height: 18, borderRadius: 5, marginRight: 10, opacity: 0.85 },
  title: { flex: 1 },
  delete: { marginHorizontal: 4 },
  noteScroll: { maxHeight: 140 },
  photos: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  thumb: { width: 84, height: 84, borderRadius: 12 },
  addPhoto: {
    width: 84,
    height: 84,
    borderRadius: 12,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tag: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14 },
  tagLabel: { fontSize: 13, lineHeight: 17, fontWeight: '700', maxWidth: 220 },
  footer: { flexDirection: 'row', justifyContent: 'flex-start' },
  viewer: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  full: { width: '100%', height: '100%' },
  viewerBar: { position: 'absolute', right: 16 },
});
