import * as storage from '@data/storage';
import type { PendingWaypoint } from '@state/recorderStore';
import * as ImagePicker from 'expo-image-picker';
import { Image, StyleSheet, View } from 'react-native';
import { Button, Dialog, Portal, TextInput, useTheme } from 'react-native-paper';

interface Props {
  /** The waypoint being edited; the dialog is visible while this is non-null. */
  waypoint: PendingWaypoint | null;
  /** Current note draft (owned by the caller so it survives photo updates). */
  draft: string;
  onChangeDraft: (text: string) => void;
  /** Save the draft note and close (also fired on outside-tap dismiss). */
  onSave: () => void;
  /** Delete the waypoint and close. */
  onDelete: () => void;
  /** Attach a stored photo uri to the waypoint ('' removes the photo). */
  onSetPhoto: (uri: string) => void;
}

/** Editor dialog for a live waypoint's note + photo (camera or library). */
export function WaypointEditorDialog({
  waypoint,
  draft,
  onChangeDraft,
  onSave,
  onDelete,
  onSetPhoto,
}: Props) {
  const theme = useTheme();

  const pickPhoto = async (fromCamera: boolean) => {
    if (!waypoint) return;
    if (fromCamera) {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) return;
    }
    const res = fromCamera
      ? await ImagePicker.launchCameraAsync({ quality: 0.6 })
      : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.6 });
    const picked = res.canceled ? null : res.assets[0]?.uri;
    if (!picked) return;
    const stored = await storage.importPhoto(picked, storage.newId());
    onSetPhoto(stored);
  };

  return (
    <Portal>
      <Dialog visible={waypoint !== null} onDismiss={onSave}>
        <Dialog.Title>{waypoint?.label ?? 'Waypoint'}</Dialog.Title>
        <Dialog.Content>
          <TextInput
            label="Note"
            value={draft}
            onChangeText={onChangeDraft}
            autoFocus
            multiline
            mode="outlined"
            placeholder="What's here?"
          />
          {waypoint?.photoUri ? (
            <View style={styles.wpPhotoWrap}>
              <Image source={{ uri: waypoint.photoUri }} style={styles.wpPhoto} />
              <Button compact icon="image-remove" onPress={() => onSetPhoto('')}>
                Remove photo
              </Button>
            </View>
          ) : (
            <View style={styles.wpPhotoButtons}>
              <Button compact icon="image-outline" onPress={() => pickPhoto(false)}>
                Photo
              </Button>
              <Button compact icon="camera-outline" onPress={() => pickPhoto(true)}>
                Camera
              </Button>
            </View>
          )}
        </Dialog.Content>
        <Dialog.Actions>
          <Button textColor={theme.colors.error} onPress={onDelete}>
            Delete
          </Button>
          <View style={styles.fill} />
          <Button onPress={onSave}>Done</Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  wpPhotoWrap: { marginTop: 12, alignItems: 'flex-start', gap: 6 },
  wpPhoto: { width: '100%', height: 180, borderRadius: 10 },
  wpPhotoButtons: { marginTop: 12, flexDirection: 'row', gap: 8 },
});
