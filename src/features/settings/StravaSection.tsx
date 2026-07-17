import { connectStrava, disconnectStrava, isStravaConfigured } from '@lib/strava';
import { useStravaStore } from '@state/stravaStore';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ActivityIndicator, List, Text } from 'react-native-paper';

/**
 * Settings § Connections — connect/disconnect Strava. The OAuth browser
 * round-trip and token storage live in `@lib/strava` / `@state/stravaStore`;
 * this section is just the rows. In builds without Strava API credentials the
 * row stays visible but disabled ("not configured in this build").
 */
export function StravaSection({ showSnack }: { showSnack: (message: string) => void }) {
  const connection = useStravaStore((s) => s.connection);
  const [busy, setBusy] = useState(false);
  const configured = isStravaConfigured();

  const onConnect = () => {
    if (busy) return;
    setBusy(true);
    connectStrava()
      .then((outcome) =>
        showSnack(
          outcome.ok
            ? `Connected to Strava${outcome.athleteName ? ` as ${outcome.athleteName}` : ''}`
            : outcome.message,
        ),
      )
      .catch(() => showSnack('Could not connect to Strava'))
      .finally(() => setBusy(false));
  };

  const onDisconnect = () => {
    if (busy) return;
    setBusy(true);
    disconnectStrava()
      .then(({ revoked }) =>
        showSnack(
          revoked
            ? 'Disconnected from Strava'
            : 'Disconnected — revoke Inukshuk at strava.com/settings/apps if it still appears',
        ),
      )
      .catch(() => showSnack('Disconnected from Strava'))
      .finally(() => setBusy(false));
  };

  return (
    <List.Section>
      <List.Subheader>Connections</List.Subheader>
      {connection ? (
        <List.Item
          title="Strava"
          description={
            connection.athleteName
              ? `Connected as ${connection.athleteName} · tap to disconnect`
              : 'Connected · tap to disconnect'
          }
          onPress={onDisconnect}
          disabled={busy}
          left={(p) => <List.Icon {...p} icon="run" />}
          right={(p) =>
            busy ? (
              <ActivityIndicator style={p.style} size={20} />
            ) : (
              <List.Icon {...p} icon="link-off" />
            )
          }
        />
      ) : (
        <List.Item
          title="Connect Strava"
          description={
            configured
              ? 'Ask to push saved trails to Strava'
              : 'Strava is not configured in this build'
          }
          onPress={onConnect}
          disabled={!configured || busy}
          left={(p) => <List.Icon {...p} icon="run" />}
          right={(p) =>
            busy ? (
              <ActivityIndicator style={p.style} size={20} />
            ) : (
              <List.Icon {...p} icon="open-in-new" />
            )
          }
        />
      )}
      <View style={styles.note}>
        <Text variant="bodySmall">
          {connection
            ? 'After you save a recording, Inukshuk offers to push it to Strava. Older trails can be sent from the Library’s ⋮ menu.'
            : 'Connecting opens Strava in your browser to authorize uploads (activity:write). Nothing is ever pushed without asking you first.'}
        </Text>
      </View>
    </List.Section>
  );
}

const styles = StyleSheet.create({
  note: { paddingHorizontal: 16, paddingVertical: 8, gap: 8 },
});
