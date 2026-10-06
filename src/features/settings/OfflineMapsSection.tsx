import { needsRedownload } from '@core/geo/tiles';
import { MAP_PACK_FORMAT } from '@features/map/mapStyle';
import { regionUpdateLayer, useOfflinePackHealth } from '@features/map/offlinePackHealth';
import { formatBytes } from '@core/format';
import type { OfflineRegion } from '@data/offline';
import { useOfflineStore } from '@state/offlineStore';
import { useSettingsStore } from '@state/settingsStore';
import { KeyboardDismissArea } from '@ui/components/KeyboardDismissArea';
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
  const progress = useOfflineStore((s) => s.progress);
  const tileUrl = useSettingsStore((s) => s.tileUrl);
  const offlineOnly = useSettingsStore((s) => s.offlineOnly);
  // Regions whose tiles sit under URLs the map no longer requests (P1-2).
  const needsUpdate = useOfflinePackHealth();

  /** Region awaiting delete confirmation; the dialog is visible while non-null. */
  const [pendingDelete, setPendingDelete] = useState<{ id: string; label: string } | null>(null);
  /** Region being renamed; the rename dialog is visible while non-null. */
  const [renaming, setRenaming] = useState<{ id: string } | null>(null);
  const [renameText, setRenameText] = useState('');
  /** Region awaiting re-download confirmation; the dialog is visible while non-null. */
  const [pendingUpdate, setPendingUpdate] = useState<OfflineRegion | null>(null);
  /** The region re-downloading now, and the last update failure per region. */
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [updateErrors, setUpdateErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    void useOfflineStore.getState().hydrate();
  }, []);

  const totalBytes = regions.reduce((sum, r) => sum + r.sizeBytes, 0);

  const confirmDelete = () => {
    if (pendingDelete) void remove(pendingDelete.id);
    setPendingDelete(null);
  };

  const confirmUpdate = () => {
    const region = pendingUpdate;
    setPendingUpdate(null);
    if (!region || updatingId !== null || progress !== null) return;
    const layer = regionUpdateLayer(tileUrl, region);
    if (!layer) return;
    setUpdatingId(region.id);
    setUpdateErrors((e) => {
      const next = { ...e };
      delete next[region.id];
      return next;
    });
    void useOfflineStore
      .getState()
      .redownload(region, layer)
      .catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        setUpdateErrors((e) => ({ ...e, [region.id]: reason }));
      })
      .finally(() => setUpdatingId(null));
  };

  /** The row's second line: what it is, or why and how far it is being updated. */
  const describe = (region: OfflineRegion): string => {
    const size = formatBytes(region.sizeBytes);
    if (updatingId === region.id) return `Updating… ${Math.round(progress?.pct ?? 0)}%`;
    const failed = updateErrors[region.id];
    if (failed !== undefined) return `Update failed — ${failed}`;
    if (needsRedownload(region, MAP_PACK_FORMAT)) return `Old map style · download again · ${size}`;
    if (needsUpdate.has(region.id)) return `Needs update · map data moved · ${size}`;
    return `${region.basemap} · ${size}`;
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
              description={describe(region)}
              right={(p) => (
                <View style={{ flexDirection: 'row' }}>
                  {needsUpdate.has(region.id) && (
                    <IconButton
                      {...p}
                      icon="download"
                      accessibilityLabel={`Update ${region.label}`}
                      disabled={updatingId !== null || progress !== null}
                      onPress={() => setPendingUpdate(region)}
                    />
                  )}
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

        <Dialog visible={pendingUpdate !== null} onDismiss={() => setPendingUpdate(null)}>
          <Dialog.Title>Update offline area?</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              {offlineOnly
                ? "Turn off 'Locally downloaded only' to download this area again."
                : `"${pendingUpdate?.label ?? ''}" was saved with map data this version no longer reads, so parts of it can show blank offline. Download it again (about ${formatBytes(pendingUpdate?.sizeBytes ?? 0)})? The current copy stays until the new one is complete.`}
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setPendingUpdate(null)}>Cancel</Button>
            <Button onPress={confirmUpdate} disabled={offlineOnly}>
              Download
            </Button>
          </Dialog.Actions>
        </Dialog>

        <Dialog visible={renaming !== null} onDismiss={() => setRenaming(null)}>
          <Dialog.Title>Rename offline area</Dialog.Title>
          <Dialog.Content>
            <KeyboardDismissArea>
              <TextInput
                label="Name"
                mode="outlined"
                value={renameText}
                onChangeText={setRenameText}
                autoFocus
                // #235 — Return dismisses the keyboard and renames.
                returnKeyType="done"
                blurOnSubmit
                onSubmitEditing={confirmRename}
              />
            </KeyboardDismissArea>
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
