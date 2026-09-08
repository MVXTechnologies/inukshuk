import * as storage from '@data/storage';
import * as ImagePicker from 'expo-image-picker';
import { Image, Keyboard, StyleSheet, View } from 'react-native';
import { useIosKeyboardHeight } from '../../common/useIosKeyboardHeight';
import { KeyboardDismissArea } from '@ui/components/KeyboardDismissArea';
import { KEYBOARD_DONE_BAR_ID, KeyboardDoneBar } from '@ui/components/KeyboardDoneBar';
import { Button, Dialog, Portal, TextInput, useTheme } from 'react-native-paper';

/**
 * The minimal waypoint shape the editor needs — satisfied by both a live
 * recording waypoint (`PendingWaypoint`) and a saved standalone `Waypoint`.
 */
interface EditableWaypoint {
  label: string;
  photoUri?: string;
}

interface Props {
  /** The waypoint being edited; the dialog is visible while this is non-null. */
  waypoint: EditableWaypoint | null;
  /**
   * Current NAME draft (#232), owned by the caller like the note draft.
   * Pre-filled with the waypoint's label — for a not-yet-created one that is
   * the next auto number, so a name left untouched numbers exactly as before.
   */
  name: string;
  onChangeName: (text: string) => void;
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

/** Editor dialog for a waypoint's note + photo (camera or library). */
export function WaypointEditorDialog({
  waypoint,
  name,
  onChangeName,
  draft,
  onChangeDraft,
  onSave,
  onDelete,
  onSetPhoto,
}: Props) {
  const theme = useTheme();

  /**
   * #235 — put the keyboard away BEFORE the dialog unmounts. Closing on top of
   * a live keyboard tears the input accessory view down while iOS still holds
   * it, which leaves a dangling accessory behind the keyboard's own dismissal
   * animation; XCUITest reproducibly died snapshotting the hierarchy in that
   * window. It is also simply better: no keyboard flashing over the map after
   * the dialog is gone.
   */
  const close = (then: () => void) => () => {
    Keyboard.dismiss();
    then();
  };

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

  const keyboardHeight = useIosKeyboardHeight();

  return (
    <Portal>
      {/* On iOS the auto-focused note input summons a keyboard that would sit
          on top of the centered dialog's Delete/Done actions, making them
          unreachable; the margin re-centers the dialog in the space above it. */}
      <Dialog
        visible={waypoint !== null}
        onDismiss={close(onSave)}
        style={keyboardHeight > 0 ? { marginBottom: keyboardHeight } : null}
      >
        {/* Static title since #232: the name is now an editable field right
            below, and a title echoing it would be a second element reading
            "Waypoint N" — ambiguous for screen readers and for Maestro, whose
            waypoint flow reads the auto number off exactly one element. */}
        <Dialog.Title>Waypoint</Dialog.Title>
        <Dialog.Content>
          <KeyboardDismissArea>
            {/* #232 — the name, first, because naming the place is the point
                of stopping to save it. Blank falls back to the auto label at
                the call site, so clearing it can never leave a nameless pin. */}
            <TextInput
              label="Name"
              // Paper's floating `label` is a sibling Text, not the input's
              // accessible name — screen readers need it spelled out.
              accessibilityLabel="Waypoint name"
              value={name}
              onChangeText={onChangeName}
              mode="outlined"
              autoCorrect={false}
              style={styles.name}
              // #235/#240 — single line: Return is the iOS way out, and here
              // it just puts the keyboard away (Done is the dialog's action).
              returnKeyType="done"
              blurOnSubmit
              onSubmitEditing={() => Keyboard.dismiss()}
            />
            <TextInput
              label="Note"
              value={draft}
              onChangeText={onChangeDraft}
              autoFocus
              multiline
              mode="outlined"
              placeholder="What's here?"
              // #235 — multiline: Return types a newline, so Done is the only exit.
              inputAccessoryViewID={KEYBOARD_DONE_BAR_ID}
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
          </KeyboardDismissArea>
          {/* Mounted HERE, not at the app root: on the New Architecture
              RCTInputAccessoryComponentView binds to its text input once, in
              didMoveToWindow, by searching the window for a field carrying the
              matching id. A bar mounted before the field exists finds nothing
              and never retries — so it has to arrive with the dialog. */}
          <KeyboardDoneBar />
        </Dialog.Content>
        <Dialog.Actions>
          <Button textColor={theme.colors.error} onPress={close(onDelete)}>
            Delete
          </Button>
          <View style={styles.fill} />
          <Button onPress={close(onSave)}>Done</Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  name: { marginBottom: 10 },
  wpPhotoWrap: { marginTop: 12, alignItems: 'flex-start', gap: 6 },
  wpPhoto: { width: '100%', height: 180, borderRadius: 10 },
  wpPhotoButtons: { marginTop: 12, flexDirection: 'row', gap: 8 },
});
