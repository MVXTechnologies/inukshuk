import { allCategories } from '@core/library/categories';
import { useLibraryStore } from '@state/libraryStore';
import { ScrollView } from 'react-native';
import { Dialog, List, Portal, useTheme } from 'react-native-paper';

interface Props {
  /** Id of the trail being categorized, or null when closed. */
  trackId: string | null;
  onDismiss: () => void;
}

/**
 * "Set category" for an existing trail (from the trail card's ⋮ menu). A
 * user-initiated Portal Dialog is fine here — it is a direct response to a tap,
 * not a spontaneous overlay on the recording path.
 */
export function SetCategoryDialog({ trackId, onDismiss }: Props) {
  const theme = useTheme();
  const customCategories = useLibraryStore((s) => s.customCategories);
  const setTrackCategory = useLibraryStore((s) => s.setTrackCategory);
  const current = useLibraryStore((s) => s.tracks.find((t) => t.id === trackId)?.category) ?? null;

  const pick = (category: string | null) => {
    if (trackId) setTrackCategory(trackId, category);
    onDismiss();
  };

  return (
    <Portal>
      <Dialog visible={trackId !== null} onDismiss={onDismiss}>
        <Dialog.Title>Set category</Dialog.Title>
        <Dialog.ScrollArea>
          <ScrollView>
            <List.Item
              title="None"
              left={(p) => <List.Icon {...p} icon="cancel" color={theme.colors.onSurfaceVariant} />}
              right={current === null ? (p) => <List.Icon {...p} icon="check" /> : undefined}
              onPress={() => pick(null)}
            />
            {allCategories(customCategories).map((c) => (
              <List.Item
                key={c.id}
                title={c.name}
                left={(p) => <List.Icon {...p} icon={c.icon} color={c.color} />}
                right={current === c.id ? (p) => <List.Icon {...p} icon="check" /> : undefined}
                onPress={() => pick(c.id)}
              />
            ))}
          </ScrollView>
        </Dialog.ScrollArea>
      </Dialog>
    </Portal>
  );
}
