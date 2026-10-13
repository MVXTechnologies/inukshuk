import { useScreenSheetStore } from '@state/screenSheetStore';
import { useEffect, useRef } from 'react';
import { BackHandler } from 'react-native';

/**
 * A bottom sheet that owns its screen while it is up (a plain View, never a
 * Paper Dialog/Portal): Android Back goes to `onBack`, and the tab bar hides
 * so the user cannot leave the screen with the sheet open.
 *
 * Both only while `active`: the sheet is up AND its screen is focused. Tab
 * screens stay mounted when you switch tabs, and a global Back listener that
 * always answers `true` would keep eating Back on the OTHER tab — closing a
 * sheet nobody can see instead of navigating (2.5.1 review). The caller folds
 * in its screen's focus (`useIsFocused()`), so the listener is registered
 * only on the screen the user is looking at.
 *
 * `onBack` is read through a ref: the listener is not re-registered on every
 * render, which would also reorder it among other Back listeners.
 */
export function useScreenSheet(active: boolean, onBack: () => void): void {
  const backRef = useRef(onBack);
  useEffect(() => {
    backRef.current = onBack;
  });
  useEffect(() => {
    if (!active) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      backRef.current();
      return true;
    });
    useScreenSheetStore.getState().opened();
    return () => {
      sub.remove();
      useScreenSheetStore.getState().closed();
    };
  }, [active]);
}
