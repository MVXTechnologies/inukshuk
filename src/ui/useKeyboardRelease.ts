import { useEffect, useRef } from 'react';
import { Keyboard } from 'react-native';

/**
 * Puts the soft keyboard away when a FOCUSED text field leaves the screen
 * with its host (a panel closing, a dialog's Create) — QA 2.6.1, the
 * "orphaned keyboard".
 *
 * Why it is needed (Android 9+): when the focused EditText is removed, the
 * framework hands focus to the first view focusable in touch mode — here the
 * app's always-mounted hidden 1 dp WebViews (the PDF rasterizer and the photo
 * resizer; the IME reported focus on a 3×3 px RNCWebView). React Native's own
 * unmount blur asks the IME to hide against a view that is already detached,
 * so the keyboard stays up, attached to the invisible WebView, covering the
 * next screen or dialog. `Keyboard.dismiss()` hides it whatever holds focus.
 *
 * Spread the returned handlers on the field (chained with its own). `open`:
 * the host's visibility, for a host that stays mounted while hidden (a
 * Paper Dialog's `visible`); the keyboard is released when it turns false.
 */
export function useKeyboardRelease(open = true): {
  onFocus: () => void;
  onBlur: () => void;
} {
  const focused = useRef(false);
  useEffect(() => {
    if (!open) releaseIfFocused(focused);
  }, [open]);
  useEffect(() => () => releaseIfFocused(focused), []);
  return {
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
    },
  };
}

function releaseIfFocused(focused: { current: boolean }): void {
  if (!focused.current) return;
  focused.current = false;
  Keyboard.dismiss();
}
