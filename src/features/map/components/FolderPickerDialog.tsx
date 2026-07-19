import { UNGROUPED_FOLDER_ID } from '@core/library/visibility';
import { useLibraryStore } from '@state/libraryStore';
import { Button, Checkbox, Dialog, Portal, Text } from 'react-native-paper';

interface Props {
  visible: boolean;
  onDismiss: () => void;
}

/**
 * Folder-mode selector: check the folders whose maps, trails and waypoints
 * the map should show (plus Ungrouped for folderless items). Bound straight
 * to the persisted `visibleFolderIds`; the map updates live behind the
 * dialog. Opened from the Layers menu's "Folders" entry (user-invoked, so a
 * Portal dialog is fine — the #108 rule bans them on launch/error paths).
 */
export function FolderPickerDialog({ visible, onDismiss }: Props) {
  const folders = useLibraryStore((s) => s.folders);
  const visibleFolderIds = useLibraryStore((s) => s.visibleFolderIds);
  const toggleVisibleFolder = useLibraryStore((s) => s.toggleVisibleFolder);

  return (
    <Portal>
      <Dialog visible={visible} onDismiss={onDismiss}>
        <Dialog.Title>Show folders</Dialog.Title>
        <Dialog.Content>
          {folders.length === 0 && (
            <Text variant="bodyMedium">
              No folders yet — create one in the Library to group maps, trails and waypoints.
            </Text>
          )}
          {folders.map((f) => (
            <Checkbox.Item
              key={f.id}
              label={f.name}
              position="leading"
              status={visibleFolderIds.includes(f.id) ? 'checked' : 'unchecked'}
              onPress={() => toggleVisibleFolder(f.id)}
            />
          ))}
          <Checkbox.Item
            label="Ungrouped"
            position="leading"
            status={visibleFolderIds.includes(UNGROUPED_FOLDER_ID) ? 'checked' : 'unchecked'}
            onPress={() => toggleVisibleFolder(UNGROUPED_FOLDER_ID)}
          />
        </Dialog.Content>
        <Dialog.Actions>
          <Button onPress={onDismiss}>Done</Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}
