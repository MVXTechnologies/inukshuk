import { discardQueuedReports, markManualReportSent } from '@lib/errorReporting';
import { useErrorPromptStore } from '@state/errorPromptStore';
import * as Linking from 'expo-linking';
import { StyleSheet } from 'react-native';
import { Banner, Text } from 'react-native-paper';

/**
 * Manual error-report fallback (no GitHub token configured in this build):
 * offers to open a pre-filled GitHub issue in the browser.
 *
 * Deliberately a **Banner, not a Dialog**. A Paper `Dialog` lives in a
 * `Portal` — a full-screen overlay that swallows every touch beneath it — and
 * it only becomes visible from its entrance-animation callback. When that
 * callback doesn't fire (animations disabled: CI emulators, Android's "remove
 * animations" accessibility setting, and the One UI quirk that already broke
 * paper's Snackbar timer — see useTimedSnackbar) the overlay is mounted but
 * invisible: the app looks normal and silently ignores every tap. That
 * soft-lock is what the 2026-07-14 e2e failures caught. A Banner renders
 * inline in the layout, so a missed animation can never block the UI.
 */
export function ErrorReportPrompt() {
  const prompt = useErrorPromptStore((s) => s.prompt);
  const clear = useErrorPromptStore((s) => s.clear);
  if (prompt === null) return null;

  const report = () => {
    const { url, fingerprint } = prompt;
    clear();
    Linking.openURL(url)
      .then(() => markManualReportSent(fingerprint))
      .catch(() => undefined); // No browser available — the report stays queued.
  };

  const discard = () => {
    discardQueuedReports();
    clear();
  };

  return (
    <Banner
      visible
      icon="bug-outline"
      style={styles.banner}
      actions={[
        { label: "Don't report", onPress: discard },
        { label: 'Later', onPress: clear },
        { label: 'Report', onPress: report },
      ]}
    >
      <Text variant="bodyMedium">
        {prompt.queuedCount === 1
          ? 'Inukshuk hit an error recently.'
          : `Inukshuk hit ${prompt.queuedCount} errors recently.`}{' '}
        You can report it on GitHub — a pre-filled issue opens in your browser. Only the error
        details and the app/device version are included.
      </Text>
    </Banner>
  );
}

const styles = StyleSheet.create({
  banner: { width: '100%' },
});
