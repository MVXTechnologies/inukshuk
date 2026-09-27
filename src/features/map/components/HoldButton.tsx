import { useEffect, useRef, type ReactNode } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  useAnimatedValue,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Svg, { Circle } from 'react-native-svg';

/** How long a hold must last to confirm (revamp `After-Targets.html`: 0.8 s). */
export const HOLD_MS = 800;

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/**
 * A round button that fires only after a sustained press, with a ring that
 * fills as the press is held (revamp: Stop needs a 0.8 s hold, no confirm
 * dialog — a pocket tap can no longer end a hike). Releasing early rewinds
 * the ring and does nothing.
 *
 * Screen readers can't hold, so the accessibility "activate" action (a
 * double-tap with VoiceOver/TalkBack) confirms directly; the hint says so.
 */
export function HoldButton({
  size,
  onConfirm,
  accessibilityLabel,
  accessibilityHint,
  trackColor,
  fillColor,
  background,
  children,
  style,
}: {
  size: number;
  onConfirm: () => void;
  accessibilityLabel: string;
  accessibilityHint: string;
  trackColor: string;
  fillColor: string;
  background: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const progress = useAnimatedValue(0);
  const animation = useRef<Animated.CompositeAnimation | null>(null);
  // The hold is decided by a timer, not by the ring's animation finishing:
  // the ring is only feedback, and an animation can be interrupted or
  // skipped (reduced motion) without that meaning "released".
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmRef = useRef(onConfirm);
  useEffect(() => {
    confirmRef.current = onConfirm;
  }, [onConfirm]);

  useEffect(
    () => () => {
      animation.current?.stop();
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const stroke = 3;
  const r = size / 2 - stroke / 2 - 1;
  const circumference = 2 * Math.PI * r;
  const dashOffset = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [circumference, 0],
  });

  const start = () => {
    animation.current?.stop();
    animation.current = Animated.timing(progress, {
      toValue: 1,
      duration: HOLD_MS,
      easing: Easing.linear,
      useNativeDriver: false,
    });
    animation.current.start();
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      progress.setValue(0);
      confirmRef.current();
    }, HOLD_MS);
  };
  const cancel = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    animation.current?.stop();
    animation.current = Animated.timing(progress, {
      toValue: 0,
      duration: 150,
      useNativeDriver: false,
    });
    animation.current.start();
  };

  return (
    <Pressable
      onPressIn={start}
      onPressOut={cancel}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityActions={[{ name: 'activate' }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'activate') onConfirm();
      }}
      style={[
        styles.button,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: background },
        style,
      ]}
    >
      <Svg width={size} height={size} style={StyleSheet.absoluteFill} pointerEvents="none">
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={trackColor}
          strokeWidth={stroke}
          fill="none"
        />
        <AnimatedCircle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={fillColor}
          strokeWidth={stroke}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={dashOffset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <View pointerEvents="none">{children}</View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { alignItems: 'center', justifyContent: 'center' },
});
