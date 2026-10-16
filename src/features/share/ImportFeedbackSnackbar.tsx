import { useImportFeedbackStore } from '@state/importFeedbackStore';
import { Snackbar } from '@ui/paper';

/** Root-level snackbar for "Imported X" feedback from the OS open-with flow. */
export function ImportFeedbackSnackbar() {
  const message = useImportFeedbackStore((s) => s.message);
  const clear = useImportFeedbackStore((s) => s.clear);
  return (
    <Snackbar visible={message !== null} onDismiss={clear} duration={Number.POSITIVE_INFINITY}>
      {message ?? ''}
    </Snackbar>
  );
}
