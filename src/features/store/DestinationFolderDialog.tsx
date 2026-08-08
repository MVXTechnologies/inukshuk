import { formatByteSize } from '@core/storage/diskBudget';
import type { Folder } from '@core/models';
import { assessFreeSpaceForWrite } from '@data/diskSpace';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Dialog, RadioButton, Text, useTheme } from 'react-native-paper';
import { NameDialog } from '../library/NameDialog';

/** RadioButton value for "no folder" (values must be strings). */
const UNGROUPED = '__ungrouped__';

interface Props {
  visible: boolean;
  /** Title of the map being downloaded (dialog heading context). */
  itemTitle: string;
  /** Download size from the manifest, when known. */
  sizeBytes?: number;
  folders: readonly Folder[];
  /** Pre-selected folder (last used); null = Ungrouped. */
  initialFolderId: string | null;
  /** Create a folder now (store's addFolder); returns its id. */
  onCreateFolder: (name: string) => string;
  onDismiss: () => void;
  onConfirm: (folderId: string | null) => void;
}

/**
 * Destination picker for a store download: radio list of folders (plus
 * Ungrouped and an inline "New folder…" via NameDialog) with a size line and
 * a free-space pre-flight — a download that cannot fit is blocked here, before
 * any bytes move.
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

  const assessment = sizeBytes !== undefined ? assessFreeSpaceForWrite(sizeBytes) : null;
  const blocked = assessment?.verdict === 'block';

  const confirm = () => onConfirm(selected === UNGROUPED ? null : selected);

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
          </RadioButton.Group>
          <View style={styles.newFolderRow}>
            <Button icon="folder-plus-outline" onPress={() => setNaming(true)}>
              New folder…
            </Button>
          </View>
        </Dialog.Content>
        <Dialog.Actions>
          <Button onPress={onDismiss}>Cancel</Button>
          <Button onPress={confirm} disabled={blocked}>
            Download
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
          setSelected(onCreateFolder(name.trim() === '' ? 'Folder' : name));
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  context: { marginBottom: 8 },
  diskNote: { marginBottom: 8 },
  newFolderRow: { flexDirection: 'row', justifyContent: 'flex-start' },
});
