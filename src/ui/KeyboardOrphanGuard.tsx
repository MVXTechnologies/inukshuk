import { ORPHAN_CHECK_MS, orphanCheck } from '@core/keyboard/orphan';
import { useEffect } from 'react';
import { Keyboard, Platform, TextInput } from 'react-native';

/**
 * Puts away a soft keyboard that no app text field holds (QA 2.6.1): see
 * `@core/keyboard/orphan`. Android only (where focus falls to the hidden
 * WebViews); mounted once at the root, next to them. Checks run only while
 * the keyboard shows.
 */
export function KeyboardOrphanGuard() {
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    let timer: ReturnType<typeof setInterval> | null = null;
    let misses = 0;
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
      misses = 0;
    };
    const start = () => {
      stop();
      timer = setInterval(() => {
        const step = orphanCheck(misses, TextInput.State.currentlyFocusedInput() != null);
        misses = step.misses;
        if (step.dismiss) {
          stop();
          Keyboard.dismiss();
        }
      }, ORPHAN_CHECK_MS);
    };
    const shown = Keyboard.addListener('keyboardDidShow', start);
    const hidden = Keyboard.addListener('keyboardDidHide', stop);
    if (Keyboard.isVisible()) start();
    return () => {
      shown.remove();
      hidden.remove();
      stop();
    };
  }, []);
  return null;
}
