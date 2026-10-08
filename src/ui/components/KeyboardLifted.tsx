/**
 * A bottom-docked view (a map card, a sheet) that rises above the software
 * keyboard while it is up, on both platforms. react-native-keyboard-controller
 * reads the IME directly: an edge-to-edge Android window is neither resized
 * for the keyboard nor told about it through React Native's own Keyboard
 * events, so docked inputs sat under the keys (2026-10-08).
 *
 * The view follows the keyboard's animated height (the library's Reanimated
 * shared value, the same source its KeyboardAvoidingView uses, which the CI
 * emulator proved), less the gap it already keeps above the window's bottom
 * edge, so a card docked over the tab bar rises only by what the keys would
 * hide. The gap is measured in window coordinates while the keyboard is down.
 * (Tried and rejected: useKeyboardState's visibility and KeyboardStickyView
 * did not move on Android; KeyboardAvoidingView "position" reads its frame
 * relative to its parent, so a docked card was off by the dock's offset.)
 */
import { useCallback, useRef, type ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import {
  useKeyboardState,
  useReanimatedKeyboardAnimation,
  useWindowDimensions,
} from 'react-native-keyboard-controller';
import Reanimated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import { restGap } from '../keyboardLift';

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
  const { height } = useReanimatedKeyboardAnimation();
  const { height: windowH } = useWindowDimensions();
  const rest = useRef<View>(null);
  const gap = useSharedValue(0);
  const measure = useCallback(() => {
    rest.current?.measureInWindow((_x, y, _w, h) => {
      // Only at rest: while the keyboard is up the view has moved.
      if (height.value === 0) gap.value = restGap(y + h, windowH);
    });
  }, [height, gap, windowH]);
  const lifted = useAnimatedStyle(() => ({
    // `height` is negative while the keyboard is up.
    transform: [{ translateY: Math.min(0, height.value + gap.value) }],
  }));
  return (
    <View
      ref={rest}
      collapsable={false}
      style={style}
      pointerEvents="box-none"
      testID={testID}
      onLayout={measure}
    >
      <Reanimated.View style={lifted} pointerEvents="box-none">
        {children}
      </Reanimated.View>
    </View>
  );
}
