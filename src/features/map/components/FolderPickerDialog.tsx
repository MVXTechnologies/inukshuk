import { UNGROUPED_FOLDER_ID } from '@core/library/visibility';
import { useLibraryStore } from '@state/libraryStore';
import { Button, Checkbox, Dialog, Portal, Text } from 'react-native-paper';

interface Props {
  visible: boolean;
  onDismiss: () => void;
}

/**
 * Folder-mode selector: check the folders whose maps, trails and waypoints
 * the map should show (plus Ungrouped for folderless items). The map updates
 * live behind the dialog. Opened from the Layers menu's "Folders" entry
 * (user-invoked, so a Portal dialog is fine — the #108 rule bans them on
 * launch/error paths).
 *
 * Every row is ONE store write: a folder tap goes through `showFolder`, which
 * flips the mode and moves the selection in a single `set()`. Writing them
 * separately serialized the whole library index twice per tap (a JS-thread
 * stall that dropped the next tap) and flashed an empty map in between.
 */
export function FolderPickerDialog({ visible, onDismiss }: Props) {
  const folders = useLibraryStore((s) => s.folders);
  const visibleFolderIds = useLibraryStore((s) => s.visibleFolderIds);
  const mapVisibilityMode = useLibraryStore((s) => s.mapVisibilityMode);
  const setMapVisibilityMode = useLibraryStore((s) => s.setMapVisibilityMode);
  const showFolder = useLibraryStore((s) => s.showFolder);
  const showEverything = mapVisibilityMode === 'type';
  // In type mode the folder rows read unchecked whatever the persisted
  // selection is — "Everything" is what's on, and the selection is only a
  // leftover waiting to be replaced by the next folder tap (see
  // nextFolderVisibility). Showing it checked made tapping it *hide* it.
  const checked = (id: string) => !showEverything && visibleFolderIds.includes(id);

  return (
    <Portal>
      <Dialog visible={visible} onDismiss={onDismiss}>
        <Dialog.Title>Show on the map</Dialog.Title>
        <Dialog.Content>
          {/* The escape hatch back to show-all: with the PDF/Trails toggles
              retired, this row IS type mode. It only ever turns ON — the rows
              below form a radio group with it, and "un-checking Everything"
              used to mean folder mode with whatever stale selection was
              persisted, i.e. usually an empty map. Hiding everything is still
              reachable by un-checking the folder rows. */}
          <Checkbox.Item
            label="Everything"
            position="leading"
            status={showEverything ? 'checked' : 'unchecked'}
            onPress={() => {
              if (!showEverything) setMapVisibilityMode('type');
            }}
          />
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
              status={checked(f.id) ? 'checked' : 'unchecked'}
              onPress={() => showFolder(f.id)}
            />
          ))}
          <Checkbox.Item
            label="Ungrouped"
            position="leading"
            status={checked(UNGROUPED_FOLDER_ID) ? 'checked' : 'unchecked'}
            onPress={() => showFolder(UNGROUPED_FOLDER_ID)}
          />
        </Dialog.Content>
        <Dialog.Actions>
          <Button onPress={onDismiss}>Done</Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}
