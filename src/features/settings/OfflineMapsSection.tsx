import { formatBytes } from '@lib/format';
import { useOfflineStore } from '@state/offlineStore';
import { useEffect, useState } from 'react';
import { Button, Dialog, IconButton, List, Portal, Text, useTheme } from 'react-native-paper';

export function OfflineMapsSection() {
  const theme = useTheme();
  const regions = useOfflineStore((s) => s.regions);
  const remove = useOfflineStore((s) => s.remove);

  /** Region awaiting delete confirmation; the dialog is visible while non-null. */
  const [pendingDelete, setPendingDelete] = useState<{ id: string; label: string } | null>(null);

  useEffect(() => {
    void useOfflineStore.getState().hydrate();
  }, []);

  const totalBytes = regions.reduce((sum, r) => sum + r.sizeBytes, 0);

  const confirmDelete = () => {
    if (pendingDelete) void remove(pendingDelete.id);
    setPendingDelete(null);
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
                <IconButton
                  {...p}
                  icon="trash-can-outline"
                  onPress={() => setPendingDelete({ id: region.id, label: region.label })}
                />
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
      </Portal>
    </List.Section>
  );
}
