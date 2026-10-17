import { formatByteSize } from '@core/storage/diskBudget';
import type { Folder } from '@core/models';
import { assessFreeSpaceForWrite } from '@data/diskSpace';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Dialog, RadioButton, Text, useTheme } from '@ui/paper';
import { NameDialog } from '../library/NameDialog';
import { useScaledStyles } from '@ui/displayScale';

/** RadioButton value for "no folder" (values must be strings). */
const UNGROUPED = '__ungrouped__';
/** RadioButton value for the folder named here, created only on Add. */
const NEW_FOLDER = '__new__';

interface Props {
  visible: boolean;
  /** Title of the map being downloaded (dialog heading context). */
  itemTitle: string;
  /** Download size from the manifest, when known. */
  sizeBytes?: number;
  folders: readonly Folder[];
  /** Pre-selected folder (last used); null = Ungrouped. */
  initialFolderId: string | null;
  /** Create a folder (store's addFolder); returns its id. Called only on Add. */
  onCreateFolder: (name: string) => string;
  onDismiss: () => void;
  onConfirm: (folderId: string | null) => void;
}

/**
 * Destination picker for a store download: radio list of folders (plus
 * Ungrouped and an inline "New folder…" via NameDialog) with a size line and
 * a free-space pre-flight — a download that cannot fit is blocked here, before
 * any bytes move.
 *
 * A folder named with "New folder…" is listed (and selected) but only created
 * when Add confirms: Cancel leaves no empty folder behind (QA 2.6.1).
 */
export function DestinationFolderDialog({
  visible,
  itemTitle,
  sizeBytes,
  folders,
  initialFolderId,
  onCreateFolder,
  onDismiss,
  onConfirm,
}: Props) {
  const styles = useScaledStyles(stylesSheet);

  const theme = useTheme();
  // The parent remounts this dialog per open (key on the pending item), so the
  // initial selection is seeded once — and a folder deleted since the last
  // download can't linger as a stale selection.
  const [selected, setSelected] = useState<string>(() =>
    initialFolderId !== null && folders.some((f) => f.id === initialFolderId)
      ? initialFolderId
      : UNGROUPED,
  );
  const [naming, setNaming] = useState(false);
  /** The name given with "New folder…", not created yet. */
  const [draft, setDraft] = useState<string | null>(null);

  const assessment = sizeBytes !== undefined ? assessFreeSpaceForWrite(sizeBytes) : null;
  const blocked = assessment?.verdict === 'block';

  const confirm = () => {
    if (selected === NEW_FOLDER && draft !== null) onConfirm(onCreateFolder(draft));
    else onConfirm(selected === UNGROUPED || selected === NEW_FOLDER ? null : selected);
  };

  return (
    <>
      <Dialog visible={visible && !naming} onDismiss={onDismiss}>
        <Dialog.Title>Add to Library</Dialog.Title>
        <Dialog.Content>
          <Text variant="bodyMedium" style={styles.context}>
            {itemTitle}
            {sizeBytes !== undefined ? ` — ${formatByteSize(sizeBytes)} download` : ''}
          </Text>
          {assessment !== null && assessment.message !== null && (
            <Text
              variant="bodySmall"
              style={[
                styles.diskNote,
                { color: blocked ? theme.colors.error : theme.colors.onSurfaceVariant },
              ]}
            >
              {assessment.message}
            </Text>
          )}
          <RadioButton.Group value={selected} onValueChange={setSelected}>
            <RadioButton.Item label="Ungrouped" value={UNGROUPED} />
            {folders.map((f) => (
              <RadioButton.Item key={f.id} label={f.name} value={f.id} />
            ))}
            {draft !== null && (
              <RadioButton.Item
                label={draft}
                accessibilityLabel={`${draft}, new folder, created when you tap Add`}
                value={NEW_FOLDER}
                testID="destination-new-folder"
              />
            )}
          </RadioButton.Group>
          <View style={styles.newFolderRow}>
            <Button icon="folder-plus-outline" onPress={() => setNaming(true)}>
              New folder…
            </Button>
          </View>
        </Dialog.Content>
        <Dialog.Actions>
          <Button onPress={onDismiss}>Cancel</Button>
          {/* "Add", not "Download": distinct from the card's Download button so
              e2e taps (and screen readers) can't hit the wrong one. */}
          <Button onPress={confirm} disabled={blocked}>
            Add
          </Button>
        </Dialog.Actions>
      </Dialog>
      <NameDialog
        visible={naming}
        title="New folder"
        label="Folder name"
        onDismiss={() => setNaming(false)}
        onSubmit={(name) => {
          setNaming(false);
          setDraft(name.trim() === '' ? 'Folder' : name.trim());
          setSelected(NEW_FOLDER);
        }}
      />
    </>
  );
}

const stylesSheet = StyleSheet.create({
  context: { marginBottom: 8 },
  diskNote: { marginBottom: 8 },
  newFolderRow: { flexDirection: 'row', justifyContent: 'flex-start' },
});
