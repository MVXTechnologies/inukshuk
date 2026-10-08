import { useEffect, useState } from 'react';
import { Dimensions, Keyboard, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Where the software keyboard's top edge is, in screen coordinates, while it
 * is up (null when it is down). Both platforms: iOS from the will-show
 * events (the card moves with the keyboard), Android from did-show (it sends
 * no will-events). On an edge-to-edge Android window the system does not
 * resize the app for the keyboard, so anything docked at the bottom has to
 * lift itself (a photo card's comment box and Send button were under the
 * keys on the CI emulator, 2026-10-08).
 *
 * Android's `screenY` is the window's visible frame bottom, which an
 * edge-to-edge window does not shrink for the keyboard (RN's ReactRootView),
 * so there it is also computed from the keyboard's own height (the IME inset
 * less the navigation bar) and the screen: the higher of the two wins.
 */
export function useKeyboardTop(): number | null {
  const [top, setTop] = useState<number | null>(null);
  const navBar = useSafeAreaInsets().bottom;
  useEffect(() => {
    const ios = Platform.OS === 'ios';
    const show = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', (e) =>
      setTop(
        ios
          ? e.endCoordinates.screenY
          : androidKeyboardTop(
              e.endCoordinates.screenY,
              e.endCoordinates.height,
              Dimensions.get('screen').height,
              navBar,
            ),
      ),
    );
    const hide = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () =>
      setTop(null),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, [navBar]);
  return top;
}

/**
 * Android: the keyboard's top edge, from RN's `screenY` (right when the
 * window is resized) and from its height above the navigation bar (right on
 * an edge-to-edge window); the higher one.
 */
export function androidKeyboardTop(
  screenY: number,
  height: number,
  screenH: number,
  navBar: number,
): number {
  return Math.min(screenY, screenH - navBar - height);
}

/** How far a view whose bottom edge is at `bottom` must rise to clear a keyboard at `top`. */
export function keyboardLift(bottom: number, top: number | null, margin = 8): number {
  return top === null ? 0 : Math.max(0, bottom + margin - top);
}
