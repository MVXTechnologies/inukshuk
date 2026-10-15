import { useEffect, useRef } from 'react';
import { Keyboard } from 'react-native';

/**
 * Puts the soft keyboard away when a FOCUSED text field leaves the screen
 * with its host (a panel closing, a dialog's Create) — QA 2.6.1, the
 * "orphaned keyboard".
 *
 * The cause — Android handing focus to a hidden WebView when the focused
 * field is removed — is blocked at the source by `FocusBlock` (#715). This
 * hook only closes the keyboard a beat earlier, while the field still holds
 * focus: `Keyboard.dismiss()` blurs the focused RN text field, and is a
 * no-op once none is focused.
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
