import { needsRedownload } from '@core/geo/tiles';
import { MAP_PACK_FORMAT } from '@features/map/mapStyle';
import {
  regionUpdateLayer,
  staleUpdateGroup,
  useOfflinePackHealth,
} from '@features/map/offlinePackHealth';
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

/** The name of one offline map to update: a region's label, or a trail download's without "(1/n)". */
function updateName(group: readonly OfflineRegion[] | null): string {
  const first = group?.[0];
  if (!first) return '';
  return group.length > 1 ? first.label.replace(/\s*\(\d+\/\d+\)$/, '') : first.label;
}

function updateBytes(group: readonly OfflineRegion[] | null): number {
  return (group ?? []).reduce((sum, r) => sum + r.sizeBytes, 0);
}

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
  /**
   * Regions awaiting re-download confirmation — one offline map: a region, or
   * every stale part of a trail download. The dialog is visible while non-null.
   */
  const [pendingUpdate, setPendingUpdate] = useState<OfflineRegion[] | null>(null);
  /** The regions of the update running now (the one downloading: `updatingId`). */
  const [updatingIds, setUpdatingIds] = useState<readonly string[]>([]);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  /** The last update failure per region. */
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
    const group = pendingUpdate;
    setPendingUpdate(null);
    if (!group || updatingIds.length > 0 || progress !== null) return;
    const ids = group.map((r) => r.id);
    setUpdatingIds(ids);
    setUpdateErrors((e) => {
      const next = { ...e };
      for (const id of ids) delete next[id];
      return next;
    });
    // One part after another (one download at a time); the first failure
    // stops the rest — offline, they would all fail the same way.
    void (async () => {
      try {
        for (const region of group) {
          const layer = regionUpdateLayer(tileUrl, region);
          if (!layer) continue;
          setUpdatingId(region.id);
          try {
            await useOfflineStore.getState().redownload(region, layer);
          } catch (err: unknown) {
            const reason = err instanceof Error ? err.message : String(err);
            setUpdateErrors((e) => ({ ...e, [region.id]: reason }));
            break;
          }
        }
      } finally {
        setUpdatingId(null);
        setUpdatingIds([]);
      }
    })();
  };

  /** The row's second line: what it is, or why and how far it is being updated. */
  const describe = (region: OfflineRegion): string => {
    const size = formatBytes(region.sizeBytes);
    if (updatingId === region.id) return `Updating… ${Math.round(progress?.pct ?? 0)}%`;
    if (updatingIds.includes(region.id)) return `Waiting to update · ${size}`;
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
                      disabled={updatingIds.length > 0 || progress !== null}
                      onPress={() =>
                        setPendingUpdate(staleUpdateGroup(region, regions, needsUpdate))
                      }
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
                : `"${updateName(pendingUpdate)}" was saved with map data this version no longer reads, so parts of it can show blank offline. Download it again (about ${formatBytes(updateBytes(pendingUpdate))})? The current copy stays until the new one is complete.`}
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
