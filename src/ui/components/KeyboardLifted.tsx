/**
 * A bottom-docked view (a map card, a sheet) that rises above the software
 * keyboard while it is up, on both platforms. The keyboard's height comes
 * from react-native-keyboard-controller, which reads the IME insets directly:
 * an edge-to-edge Android window is neither resized for the keyboard nor told
 * about it through React Native's own Keyboard events (no layout pass), so
 * docked inputs sat under the keys (2026-10-08). The untransformed outer view
 * is measured, so the lift never feeds back into the measure.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Dimensions, View, type StyleProp, type ViewStyle } from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';

import { keyboardLift } from '../keyboardLift';

/** The keyboard's height while it is up, else 0 (both platforms). */
export function useKeyboardHeight(): number {
  return useKeyboardState((s) => (s.isVisible ? s.height : 0));
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
  const height = useKeyboardHeight();
  const rest = useRef<View>(null);
  const [lift, setLift] = useState(0);
  useEffect(() => {
    if (height === 0) return;
    const top = Dimensions.get('screen').height - height;
    rest.current?.measureInWindow((_x, y, _w, h) => setLift(keyboardLift(y + h, top)));
  }, [height]);
  return (
    <View ref={rest} collapsable={false} style={style} pointerEvents="box-none" testID={testID}>
      <View
        pointerEvents="box-none"
        style={{ transform: [{ translateY: height === 0 ? 0 : -lift }] }}
      >
        {children}
      </View>
    </View>
  );
}
