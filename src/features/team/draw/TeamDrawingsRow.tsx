/**
 * Manage team › Drawings (#683, admins): how many drawings are on the map,
 * and "Clear all", which removes everyone's for everyone (after a confirm).
 * The map itself only offers "Clear mine".
 */
import { useTeamStore, teamService } from '@state/teamStore';
import { Alert, StyleSheet } from 'react-native';
import { Button, List } from 'react-native-paper';

export function TeamDrawingsRow() {
  const count = useTeamStore((s) => s.drawings.length);
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

const styles = StyleSheet.create({ item: { paddingHorizontal: 0, marginHorizontal: -8 } });
