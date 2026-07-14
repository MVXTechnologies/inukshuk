import { discardQueuedReports, markManualReportSent } from '@lib/errorReporting';
import { useErrorPromptStore } from '@state/errorPromptStore';
import * as Linking from 'expo-linking';
import { Button, Dialog, Portal, Text } from 'react-native-paper';

/**
 * Manual error-report fallback dialog (no GitHub token configured in this
 * build): asks the user whether to open a pre-filled GitHub issue in the
 * browser. Root-level, driven by {@link useErrorPromptStore}.
 */
export function ErrorReportPrompt() {
  const prompt = useErrorPromptStore((s) => s.prompt);
  const clear = useErrorPromptStore((s) => s.clear);
  if (prompt === null) return null;

  const report = async () => {
    const { url, fingerprint } = prompt;
    clear();
    try {
      await Linking.openURL(url);
      markManualReportSent(fingerprint);
    } catch {
      // No browser available — keep the report queued for a later attempt.
    }
  };

  const discard = () => {
    discardQueuedReports();
    clear();
  };

  return (
    <Portal>
      <Dialog visible onDismiss={clear}>
        <Dialog.Title>Report a problem?</Dialog.Title>
        <Dialog.Content>
          <Text variant="bodyMedium">
            {prompt.queuedCount === 1
              ? 'Inukshuk hit an error recently.'
              : `Inukshuk hit ${prompt.queuedCount} errors recently.`}{' '}
            You can report it on GitHub — a pre-filled issue will open in your browser. No personal
            data is included beyond the error details and app/device version.
          </Text>
        </Dialog.Content>
        <Dialog.Actions>
          <Button onPress={discard}>Don&apos;t report</Button>
          <Button onPress={clear}>Later</Button>
          <Button onPress={report}>Report</Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}
