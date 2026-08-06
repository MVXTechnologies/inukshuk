import { useTimedSnackbar } from '@features/common/useTimedSnackbar';
import { useRouter } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Appbar, Divider, List, Snackbar, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StravaSection } from './StravaSection';

/**
 * Settings § Third-party sync — the one page gathering every external-service
 * connection. Strava is live (connect/disconnect via `StravaSection`); Garmin
 * Connect is listed but disabled until Garmin grants Activity-API access (see
 * docs/superpowers/specs/2026-08-04-garmin-developer-application.md) — the row
 * exists now so the page ships with its final shape and the Garmin work only
 * has to swap the row's state.
 */
export function ThirdPartySyncScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { message: snack, show: showSnack, dismiss: dismissSnack } = useTimedSnackbar(3500);

  return (
    <View style={styles.fill}>
      <Appbar.Header>
        <Appbar.BackAction onPress={() => router.back()} accessibilityLabel="Back" />
        <Appbar.Content title="Third-party sync" />
      </Appbar.Header>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
        <StravaSection showSnack={showSnack} />

        <Divider />

        <List.Section>
          <List.Subheader>Garmin</List.Subheader>
          <List.Item
            title="Garmin Connect"
            description="Coming soon — waiting on Garmin developer approval"
            disabled
            left={(p) => <List.Icon {...p} icon="watch" />}
          />
          <View style={styles.note}>
            <Text variant="bodySmall">
              Once Garmin approves API access, you will link your Garmin account here and finished
              watch activities will appear in your Library automatically.
            </Text>
          </View>
        </List.Section>
      </ScrollView>

      <Snackbar
        visible={snack !== null}
        onDismiss={dismissSnack}
        duration={Number.POSITIVE_INFINITY}
      >
        {snack ?? ''}
      </Snackbar>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  note: { paddingHorizontal: 16, paddingVertical: 8, gap: 8 },
});
