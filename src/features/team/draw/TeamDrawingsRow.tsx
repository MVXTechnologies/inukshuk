/**
 * Manage team › Drawings (#683, admins): how many drawings are on the map,
 * and "Clear all", which removes everyone's for everyone (after a confirm).
 * The map itself only offers "Clear mine".
 */
import { onMapCount } from '@core/teamdraw/fade';
import { useTeamStore, teamService } from '@state/teamStore';
import { useEffect, useMemo, useState } from 'react';
import { Alert, StyleSheet } from 'react-native';
import { Button, List } from '@ui/paper';
import { useScaledStyles } from '@ui/displayScale';

const drawNow = () => teamService()?.active?.draw.clock() ?? Date.now();

export function TeamDrawingsRow() {
  const styles = useScaledStyles(stylesSheet);

  const shapes = useTeamStore((s) => s.drawings);
  // The drawing clock (the replica's HLC), read again on new drawings and
  // when the next one fades out.
  const [tick, setTick] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => drawNow(), [shapes, tick]);
  const { count, changesAt } = onMapCount(shapes, now);
  useEffect(() => {
    if (changesAt === null) return;
    const timer = setTimeout(() => setTick((n) => n + 1), Math.max(0, changesAt - now) + 1);
    return () => clearTimeout(timer);
  }, [changesAt, now]);
  const isAdmin = useTeamStore((s) => s.view?.isAdmin ?? false);
  const readOnly = useTeamStore((s) => s.view?.readOnly ?? true);
  if (!isAdmin) return null;
  const clearAll = () =>
    Alert.alert('Clear all drawings?', 'Every teammate’s drawings leave the map, for everyone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear all',
        style: 'destructive',
        onPress: () => {
          teamService()?.active?.draw.clearAll();
          useTeamStore.getState().refresh();
        },
      },
    ]);
  return (
    <List.Item
      title="Drawings"
      description={count === 0 ? 'None on the map' : `${count} on the map`}
      left={(p) => <List.Icon {...p} icon="draw" />}
      right={() =>
        count > 0 && !readOnly ? (
          <Button compact onPress={clearAll} testID="team-drawings-clear">
            Clear all
          </Button>
        ) : null
      }
      style={styles.item}
      testID="team-drawings-row"
    />
  );
}

const stylesSheet = StyleSheet.create({ item: { paddingHorizontal: 0, marginHorizontal: -8 } });
