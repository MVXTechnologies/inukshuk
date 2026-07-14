import { formatBytes } from '@lib/format';
import { useOfflineStore } from '@state/offlineStore';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import {
  Button,
  Dialog,
  IconButton,
  List,
  Portal,
  Text,
  TextInput,
  useTheme,
} from 'react-native-paper';

export function OfflineMapsSection() {
  const theme = useTheme();
  const regions = useOfflineStore((s) => s.regions);
  const remove = useOfflineStore((s) => s.remove);
  const rename = useOfflineStore((s) => s.rename);

  /** Region awaiting delete confirmation; the dialog is visible while non-null. */
  const [pendingDelete, setPendingDelete] = useState<{ id: string; label: string } | null>(null);
  /** Region being renamed; the rename dialog is visible while non-null. */
  const [renaming, setRenaming] = useState<{ id: string } | null>(null);
  const [renameText, setRenameText] = useState('');

  useEffect(() => {
    void useOfflineStore.getState().hydrate();
  }, []);

  const totalBytes = regions.reduce((sum, r) => sum + r.sizeBytes, 0);

  const confirmDelete = () => {
    if (pendingDelete) void remove(pendingDelete.id);
    setPendingDelete(null);
  };

  const beginRename = (region: { id: string; label: string }) => {
    setRenameText(region.label);
    setRenaming({ id: region.id });
  };

  const confirmRename = () => {
    const label = renameText.trim();
    if (renaming && label !== '') void rename([renaming.id], label);
    setRenaming(null);
  };

  return (
    <List.Section>
      <List.Subheader>Offline maps</List.Subheader>
      {regions.length === 0 ? (
        <List.Item
          title="No offline maps yet"
          description="Draw an area on the map to download one."
        />
      ) : (
        <>
          {regions.map((region) => (
            <List.Item
              key={region.id}
              title={region.label}
              description={`${region.basemap} · ${formatBytes(region.sizeBytes)}`}
              right={(p) => (
                <View style={{ flexDirection: 'row' }}>
                  <IconButton {...p} icon="pencil-outline" onPress={() => beginRename(region)} />
                  <IconButton
                    {...p}
                    icon="trash-can-outline"
                    onPress={() => setPendingDelete({ id: region.id, label: region.label })}
                  />
                </View>
              )}
            />
          ))}
          <List.Item title="Total" description={formatBytes(totalBytes)} />
        </>
      )}

      <Portal>
        <Dialog visible={pendingDelete !== null} onDismiss={() => setPendingDelete(null)}>
          <Dialog.Title>Delete offline area?</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              {`Delete offline area "${pendingDelete?.label ?? ''}"? Tiles will need downloading again.`}
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setPendingDelete(null)}>Cancel</Button>
            <Button textColor={theme.colors.error} onPress={confirmDelete}>
              Delete
            </Button>
          </Dialog.Actions>
        </Dialog>

        <Dialog visible={renaming !== null} onDismiss={() => setRenaming(null)}>
          <Dialog.Title>Rename offline area</Dialog.Title>
          <Dialog.Content>
            <TextInput
              label="Name"
              mode="outlined"
              value={renameText}
              onChangeText={setRenameText}
              autoFocus
              onSubmitEditing={confirmRename}
            />
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setRenaming(null)}>Cancel</Button>
            <Button onPress={confirmRename} disabled={renameText.trim() === ''}>
              Save
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </List.Section>
  );
}
