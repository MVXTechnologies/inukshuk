/**
 * A bottom-docked view (a map card, a sheet) that rises above the software
 * keyboard while it is up, on both platforms. react-native-keyboard-controller
 * reads the IME directly: an edge-to-edge Android window is neither resized
 * for the keyboard nor told about it through React Native's own Keyboard
 * events, so docked inputs sat under the keys (2026-10-08).
 *
 * When the keyboard's height changes, the (untransformed) outer view is
 * measured where it is now — its dock can itself shift as the keyboard opens
 * — and the content rises by how far the keyboard's top edge covers its
 * bottom, following the library's Reanimated open/close progress.
 *
 * Found on the CI emulator with logged values (runs 37799431929, 37805821997):
 * a lift from a gap measured once at rest came up short, because the dock
 * moved after the keyboard opened, and measureInWindow is offset by the status
 * bar on Android. Tried and rejected before that: KeyboardStickyView
 * (plain-Animated values) and KeyboardAvoidingView "position" (frame read
 * relative to its parent, wrong for a docked card).
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
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
  const rest = useRef<View>(null);
  const lift = useSharedValue(0);
  useEffect(() => {
    if (keyboardHeight <= 0) return;
    // Screen coordinates (pageY), the frame the keyboard height and the
    // library's window height use. Android's measureInWindow sits a status
    // bar higher (48.76 dp on the CI emulator), so the lift came up short.
    rest.current?.measure((_x, _y, _w, h, _pageX, pageY) => {
      lift.value = keyboardLift(pageY + h, windowH - keyboardHeight);
    });
  }, [keyboardHeight, windowH, lift]);
  const lifted = useAnimatedStyle(() => ({
    transform: [{ translateY: -lift.value * progress.value }],
  }));
  return (
    <View ref={rest} collapsable={false} style={style} pointerEvents="box-none" testID={testID}>
      <Reanimated.View style={lifted} pointerEvents="box-none">
        {children}
      </Reanimated.View>
    </View>
  );
}
