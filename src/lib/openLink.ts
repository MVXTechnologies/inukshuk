import * as Clipboard from 'expo-clipboard';
import { Alert, Linking } from 'react-native';

/**
 * Open a web link in the system browser, and never leave the tap unanswered.
 *
 * `Linking.openURL` rejects when the OS will not open the address ("Unable to
 * open URL: …" on iOS). Called as `void Linking.openURL(url)` that rejection
 * was unhandled: the button did nothing and the error reporter filed it
 * (#373, every link on iOS 27 so far). Here a refusal copies the address and
 * says so, so the person can paste it into a browser. Resolves to whether the
 * link opened. Never rejects.
 */
export async function openExternalLink(url: string): Promise<boolean> {
  if (url.trim() === '') return false;
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    let copied = false;
    try {
      copied = await Clipboard.setStringAsync(url);
    } catch {
      // Still tell the person; the address is in the message.
    }
    Alert.alert(
      'Could not open the link',
      copied
        ? `The address was copied. Paste it into your browser:\n\n${url}`
        : `Open this address in your browser:\n\n${url}`,
    );
    return false;
  }
}
