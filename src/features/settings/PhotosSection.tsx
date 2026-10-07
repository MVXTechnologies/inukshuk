import { isPhotoCirclesAppear, isPhotoCopySize } from '@core/photos/settings';
import { deleteAllPhotosPrompt, describePhotoUsage } from '@core/photos/settingsText';
import { deleteAllTrailPhotos, photoStorageUsage, type PhotoUsage } from '@data/photos/photoFiles';
import { reportError } from '@lib/errorReporting';
import { useLibraryStore } from '@state/libraryStore';
import { useSettingsStore } from '@state/settingsStore';
import { useTrailPhotosStore } from '@state/trailPhotosStore';
import { useCallback, useEffect, useState } from 'react';
import { InteractionManager, Linking, Platform, StyleSheet, View } from 'react-native';
import {
  Button,
  Dialog,
  Icon,
  List,
  Portal,
  SegmentedButtons,
  Switch,
  Text,
  useTheme,
} from 'react-native-paper';

/**
 * Settings › Photos (#587, mockup 06): where trail photos show, the copies
 * Inukshuk keeps and what they weigh, sharing, and deleting every copy. The
 * privacy promise leads: nothing is ever uploaded.
 */
export function PhotosSection({ showSnack }: { showSnack: (message: string) => void }) {
  const theme = useTheme();
  const onMainMap = useSettingsStore((s) => s.photosOnMainMap);
  const appear = useSettingsStore((s) => s.photoCirclesAppear);
  const copySize = useSettingsStore((s) => s.photoCopySize);
  const includeWhenSharing = useSettingsStore((s) => s.includePhotosWhenSharing);
  const set = useSettingsStore((s) => s.set);

  // Walking every trail folder is file I/O: after the section has drawn.
  const [usage, setUsage] = useState<PhotoUsage | null>(null);
  const refreshUsage = useCallback(() => {
    const task = InteractionManager.runAfterInteractions(() => {
      try {
        setUsage(photoStorageUsage());
      } catch (err) {
        reportError(err, 'photo-storage-usage');
        setUsage({ photos: 0, trails: 0, bytes: 0 });
      }
    });
    return () => task.cancel();
  }, []);
  useEffect(refreshUsage, [refreshUsage]);

  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deleteAll = () => {
    setConfirming(false);
    setDeleting(true);
    try {
      deleteAllTrailPhotos();
      useTrailPhotosStore.getState().forgetAll();
      useLibraryStore.getState().clearTrackPhotoSummaries();
      showSnack('Photo copies deleted');
    } catch (err) {
      reportError(err, 'photo-delete-all');
      showSnack('Could not delete every photo copy. Try again.');
    } finally {
      setDeleting(false);
      refreshUsage();
    }
  };

  const hasCopies = usage !== null && usage.photos > 0;

  return (
    <List.Section>
      <View
        style={[styles.privacy, { backgroundColor: theme.colors.surfaceVariant }]}
        testID="photos-privacy-card"
      >
        <Icon source="shield-lock-outline" size={22} color={theme.colors.primary} />
        <Text variant="bodyMedium" style={[styles.privacyText, { color: theme.colors.onSurface }]}>
          <Text style={styles.bold}>Your photos never leave this phone. </Text>
          Inukshuk keeps small copies for your trails and never uploads them — not to us, not to
          anyone.
        </Text>
      </View>

      <List.Item
        title="Show photos on the main map"
        description="On trails you show on the map"
        right={() => (
          <Switch
            value={onMainMap}
            onValueChange={(v) => set('photosOnMainMap', v)}
            accessibilityLabel="Show photos on the main map"
          />
        )}
      />

      <List.Item title="Photo circles appear" description="On the main map" />
      <View style={styles.segment}>
        <SegmentedButtons
          value={appear}
          onValueChange={(v) => {
            if (isPhotoCirclesAppear(v)) set('photoCirclesAppear', v);
          }}
          buttons={[
            { value: 'trail', label: 'Trail view only' },
            { value: 'zoomed', label: 'Zoomed in', disabled: !onMainMap },
            { value: 'always', label: 'Always', disabled: !onMainMap },
          ]}
        />
      </View>

      <List.Item
        title="Copies kept"
        description={describePhotoUsage(usage)}
        testID="photos-usage"
      />
      <View style={styles.segment}>
        <SegmentedButtons
          value={copySize}
          onValueChange={(v) => {
            if (isPhotoCopySize(v)) set('photoCopySize', v);
          }}
          buttons={[
            { value: 'optimized', label: 'Optimized · 2048 px' },
            { value: 'full', label: 'Full size' },
          ]}
        />
        <Text variant="bodySmall" style={[styles.hint, { color: theme.colors.onSurfaceVariant }]}>
          {copySize === 'full'
            ? 'New photos keep their full resolution (3–6 MB each), location data removed.'
            : 'About 0.7 MB per photo, sharp on any phone screen.'}
        </Text>
      </View>

      <List.Item
        title="Include photos when sharing a trail"
        description="Off: the GPX is shared alone. On: a zip with the photos (no location data inside the photo files)"
        descriptionNumberOfLines={3}
        right={() => (
          <Switch
            value={includeWhenSharing}
            onValueChange={(v) => set('includePhotosWhenSharing', v)}
            accessibilityLabel="Include photos when sharing a trail"
          />
        )}
      />

      {Platform.OS === 'ios' && (
        <List.Item
          title="Photo library access"
          description="Selected photos only · you pick each time"
          onPress={() => void Linking.openSettings()}
          right={(p) => <List.Icon {...p} icon="open-in-new" />}
        />
      )}

      <List.Item
        title="Delete all photo copies"
        titleStyle={{ color: theme.colors.error }}
        description="Removes them from your trails. Your photo library is not touched."
        descriptionNumberOfLines={2}
        disabled={!hasCopies || deleting}
        onPress={() => setConfirming(true)}
        testID="photos-delete-all"
      />

      {/* User-initiated only, so a Portal dialog is safe here (see paper-portal-touch-swallow). */}
      <Portal>
        <Dialog visible={confirming} onDismiss={() => setConfirming(false)}>
          <Dialog.Title>Delete all photo copies</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">{deleteAllPhotosPrompt(usage)}</Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setConfirming(false)}>Cancel</Button>
            <Button textColor={theme.colors.error} onPress={deleteAll}>
              Delete
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </List.Section>
  );
}

const styles = StyleSheet.create({
  privacy: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 14,
    borderRadius: 14,
  },
  privacyText: { flex: 1, lineHeight: 20 },
  bold: { fontWeight: '700' },
  segment: { paddingHorizontal: 16, paddingBottom: 8, gap: 6 },
  hint: { paddingHorizontal: 2 },
});
