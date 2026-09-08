import { useLibraryStore } from '@state/libraryStore';
import { useRouter } from 'expo-router';
import { Snackbar } from 'react-native-paper';

/** A recovered page is paused, never deleted; retry stays an explicit library action. */
export function PdfRecoverySnackbar() {
  const message = useLibraryStore((s) => s.pdfRecoveryNotice);
  const dismiss = useLibraryStore((s) => s.dismissPdfRecoveryNotice);
  const router = useRouter();
  return (
    <Snackbar
      visible={message !== null}
      onDismiss={dismiss}
      duration={Number.POSITIVE_INFINITY}
      action={{
        label: 'Library',
        onPress: () => {
          dismiss();
          router.navigate('/library');
        },
      }}
    >
      {message ?? ''}
    </Snackbar>
  );
}
