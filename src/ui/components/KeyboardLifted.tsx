/**
 * A bottom-docked view (a map card, a sheet) that rises above the software
 * keyboard while it is up, on both platforms. react-native-keyboard-controller
 * reads the IME directly: an edge-to-edge Android window is neither resized
 * for the keyboard nor told about it through React Native's own Keyboard
 * events, so docked inputs sat under the keys (2026-10-08).
 *
 * The view moves with the keyboard (KeyboardStickyView, its animated
 * height), less the gap it already keeps above the screen's bottom edge (a
 * card docked over the tab bar rises only by what the keys would cover).
 * The gap is measured while the keyboard is down.
 */
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Dimensions, View, type StyleProp, type ViewStyle } from 'react-native';
import { KeyboardStickyView, useKeyboardState } from 'react-native-keyboard-controller';

import { restGap } from '../keyboardLift';

/** The keyboard's height while it is up, else 0 (both platforms). */
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
  const rest = useRef<View>(null);
  const [gap, setGap] = useState(0);
  const keyboardUp = useKeyboardState((s) => s.height > 0);
  const measure = useCallback(() => {
    if (keyboardUp) return;
    rest.current?.measureInWindow((_x, y, _w, h) =>
      setGap(restGap(y + h, Dimensions.get('screen').height)),
    );
  }, [keyboardUp]);
  return (
    <View
      ref={rest}
      collapsable={false}
      style={style}
      pointerEvents="box-none"
      testID={testID}
      onLayout={measure}
    >
      <KeyboardStickyView offset={{ closed: 0, opened: gap }} pointerEvents="box-none">
        {children}
      </KeyboardStickyView>
    </View>
  );
}
