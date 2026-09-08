import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

/**
 * Current iOS keyboard height, accessory bar included (0 on Android, which
 * resizes the window instead).
 *
 * Paper's Dialog is absolutely positioned by its Modal wrapper, so a
 * KeyboardAvoidingView around it has no effect — the dialog must be shifted
 * explicitly or the keyboard covers its actions. `endCoordinates.height`
 * already counts the `inputAccessoryView`, so a dialog using this clears the
 * #235 Done bar as well as the keys.
 *
 * Shared by every dialog that hosts a text field; it was copy-pasted into
 * three of them before #235 added a fourth reason to get it right.
 */
export function useIosKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const show = Keyboard.addListener('keyboardWillShow', (e) =>
      setHeight(e.endCoordinates.height),
    );
    const hide = Keyboard.addListener('keyboardWillHide', () => setHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return height;
}
