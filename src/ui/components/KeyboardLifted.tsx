/**
 * A bottom-docked view (a map card, a sheet) that rises above the software
 * keyboard while it is up, on both platforms. react-native-keyboard-controller
 * reads the IME directly: an edge-to-edge Android window is neither resized
 * for the keyboard nor told about it through React Native's own Keyboard
 * events, so docked inputs sat under the keys (2026-10-08).
 *
 * The view's bottom edge is measured while the keyboard is down (no lift
 * applied), in screen coordinates: `measure`'s pageY, the frame the keyboard
 * height and the library's window height use (Android's measureInWindow sits
 * a status bar higher, 48.76 dp on the CI emulator, run 37805821997). With the
 * keyboard up, the view rises by how far the keyboard's top edge covers that
 * bottom edge, following the library's Reanimated open/close progress.
 *
 * This view itself moves, so give it the dock's style and put it in a parent
 * that spans the screen: on Android a view moved outside its parents' bounds
 * still draws but is "not visible to user", so it leaves the accessibility
 * tree (TalkBack, and E2E taps: run 37814960809). Tried and rejected before:
 * KeyboardStickyView (plain-Animated values) and KeyboardAvoidingView
 * "position" (frame read relative to its parent, wrong for a docked card).
 */
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import type { StyleProp, View, ViewStyle } from 'react-native';
import {
  useKeyboardState,
  useReanimatedKeyboardAnimation,
  useWindowDimensions,
} from 'react-native-keyboard-controller';
import Reanimated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import { keyboardLift } from '../keyboardLift';

/** The keyboard's height (0 when down): for sizing, not for moving views. */
export function useKeyboardHeight(): number {
  return useKeyboardState((s) => s.height);
}

export function KeyboardLifted({
  children,
  style,
  testID,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const { progress } = useReanimatedKeyboardAnimation();
  const keyboardHeight = useKeyboardHeight();
  const { height: windowH } = useWindowDimensions();
  const view = useRef<View>(null);
  /** The bottom edge at rest, in screen coordinates (null until measured). */
  const restBottom = useRef<number | null>(null);
  const keyboardUp = useRef(false);
  const lift = useSharedValue(0);

  const measureRest = useCallback(() => {
    // Only at rest: with the keyboard up (or still closing) the view is lifted.
    if (keyboardUp.current || progress.value > 0) return;
    view.current?.measure((_x, _y, _w, h, _pageX, pageY) => {
      if (Number.isFinite(pageY) && h > 0) restBottom.current = pageY + h;
    });
  }, [progress]);

  useEffect(() => {
    keyboardUp.current = keyboardHeight > 0;
    if (keyboardHeight <= 0) return;
    const bottom = restBottom.current;
    if (bottom === null) return;
    lift.value = keyboardLift(bottom, windowH - keyboardHeight);
  }, [keyboardHeight, windowH, lift]);

  const lifted = useAnimatedStyle(() => ({
    transform: [{ translateY: -lift.value * progress.value }],
  }));
  return (
    <Reanimated.View
      ref={view}
      collapsable={false}
      style={[style, lifted]}
      onLayout={measureRest}
      pointerEvents="box-none"
      testID={testID}
    >
      {children}
    </Reanimated.View>
  );
}
