import { findCategory, type CustomCategory } from '@core/library/categories';
import type { TrackSummary } from '@core/models';
import { formatDistance, formatDuration } from '@state/formatters';
import { ScrollView } from 'react-native';
import { Button, Dialog, List, Portal } from 'react-native-paper';

/**
 * Picker for a calendar day holding several activities: tap one to open its
 * trail view. User-invoked from a settled screen, so the "no Portal on
 * launch/error paths" rule doesn't apply.
 */
export function DayActivitiesDialog({
  title,
  tracks,
  customCategories,
  onPick,
  onDismiss,
}: {
  /** e.g. "Activities on Jul 8" — null hides the dialog. */
  title: string | null;
  tracks: readonly TrackSummary[];
  customCategories: readonly CustomCategory[];
  onPick: (trackId: string) => void;
  onDismiss: () => void;
}) {
  return (
    <Portal>
      <Dialog visible={title !== null} onDismiss={onDismiss}>
        <Dialog.Title>{title ?? ''}</Dialog.Title>
        <Dialog.ScrollArea style={{ paddingHorizontal: 0 }}>
          <ScrollView>
            {tracks.map((t) => {
              const category = findCategory(t.category, [...customCategories]);
              const timed = t.stats.movingTimeS > 0;
              return (
                <List.Item
                  key={t.id}
                  title={t.name}
                  description={`${formatDistance(t.stats.distanceM)}${
                    timed ? ` · ${formatDuration(t.stats.movingTimeS)}` : ''
                  }`}
                  left={(props) => (
                    <List.Icon
                      {...props}
                      icon={category?.icon ?? 'circle-medium'}
                      color={category?.color ?? undefined}
                    />
                  )}
                  onPress={() => onPick(t.id)}
                />
              );
            })}
          </ScrollView>
        </Dialog.ScrollArea>
        <Dialog.Actions>
          <Button onPress={onDismiss}>Cancel</Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}
