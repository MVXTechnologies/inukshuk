import { packCellLabel, type MarinePackRecord } from '@core/geo/marinePacks';
import { marineSourceById } from '@core/geo/marineSources';
import { formatBytes } from '@core/format';
import { useMarinePackStore } from '@state/marinePackStore';
import { useSettingsStore } from '@state/settingsStore';
import { useEffect, useState } from 'react';
import {
  List,
  Switch,
  Text,
  Button,
  Dialog,
  IconButton,
  Portal,
  useTheme,
} from 'react-native-paper';

/**
 * Offline marine packs in Settings → Data settings (marine wave D §D4),
 * sitting beside the offline-maps section it deliberately mirrors: list,
 * per-pack size, delete, total, plus the auto-update switch.
 *
 * A pack is one 0.1° cell of raw depth grid, so the list is naturally a list
 * of small reaches rather than named regions — each row is labelled by its
 * south-west corner and its source, which is also the honest answer to "how
 * good is this data?".
 */
export function MarinePacksSection() {
  const theme = useTheme();
  const packs = useMarinePackStore((s) => s.packs);
  const totalBytes = useMarinePackStore((s) => s.totalBytes);
  const remove = useMarinePackStore((s) => s.remove);
  const autoUpdate = useSettingsStore((s) => s.marinePackAutoUpdate);
  const setSetting = useSettingsStore((s) => s.set);

  /** Pack awaiting delete confirmation; the dialog shows while non-null. */
  const [pendingDelete, setPendingDelete] = useState<MarinePackRecord | null>(null);

  useEffect(() => {
    void useMarinePackStore.getState().hydrate();
  }, []);

  const confirmDelete = () => {
    if (pendingDelete) void remove(pendingDelete.key);
    setPendingDelete(null);
  };

  const describe = (pack: MarinePackRecord): string => {
    const source = marineSourceById(pack.sourceId);
    const age = new Date(pack.updatedAt);
    return `${source.label} · ${formatBytes(pack.bytes)} · updated ${age.toLocaleDateString()}`;
  };

  return (
    <List.Section>
      <List.Subheader>Offline marine packs</List.Subheader>
      {packs.length === 0 ? (
        <List.Item
          title="No marine packs yet"
          description="Turn on Marine in Map overlays; the map offers a free pack where the depth data is coarse."
          descriptionNumberOfLines={3}
        />
      ) : (
        <>
          {packs.map((pack) => (
            <List.Item
              key={pack.key}
              title={packCellLabel(pack.bbox)}
              description={describe(pack)}
              right={(p) => (
                <IconButton
                  {...p}
                  icon="trash-can-outline"
                  accessibilityLabel="Delete marine pack"
                  onPress={() => setPendingDelete(pack)}
                />
              )}
            />
          ))}
          <List.Item title="Total" description={formatBytes(totalBytes)} />
        </>
      )}
      <List.Item
        title="Auto-update marine packs"
        // HONEST LABEL: the app ships no network-type native module (it must
        // stay OTA-able), so this cannot promise "Wi-Fi only" — it refreshes
        // packs older than 30 days when the app comes forward online.
        description="Refresh packs older than 30 days when the app opens online"
        descriptionNumberOfLines={2}
        right={() => (
          <Switch
            value={autoUpdate}
            accessibilityLabel="Auto-update marine packs"
            onValueChange={(v) => setSetting('marinePackAutoUpdate', v)}
          />
        )}
      />

      <Portal>
        <Dialog visible={pendingDelete !== null} onDismiss={() => setPendingDelete(null)}>
          <Dialog.Title>Delete marine pack?</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              {`Delete the depth data for ${
                pendingDelete === null ? '' : packCellLabel(pendingDelete.bbox)
              }? The chart there will need a connection again.`}
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
