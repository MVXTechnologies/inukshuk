import { useState } from 'react';
import { Image, StyleSheet } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

/**
 * One page of the photo viewer (#587): pinch to zoom (double tap toggles
 * 2.5×), pan while zoomed, and — not zoomed — a drag down closes the viewer.
 * Horizontal drags are left to the pager unless the photo is zoomed, when
 * the pager is told to stop (`onZoomChange`) so the pan can move the photo.
 */
export function ZoomablePhoto({
  uri,
  width,
  height,
  onZoomChange,
  onDismiss,
  accessibilityLabel,
}: {
  uri: string;
  width: number;
  height: number;
  onZoomChange: (zoomed: boolean) => void;
  onDismiss: () => void;
  accessibilityLabel: string;
}) {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);
  const [zoomed, setZoomed] = useState(false);

  const setZoom = (z: boolean) => {
    setZoomed(z);
    onZoomChange(z);
  };

  const reset = () => {
    'worklet';
    scale.value = withTiming(1);
    savedScale.value = 1;
    tx.value = withTiming(0);
    ty.value = withTiming(0);
    savedTx.value = 0;
    savedTy.value = 0;
    runOnJS(setZoom)(false);
  };

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.min(5, Math.max(1, savedScale.value * e.scale));
    })
    .onEnd(() => {
      if (scale.value < 1.05) reset();
      else {
        savedScale.value = scale.value;
        runOnJS(setZoom)(true);
      }
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      if (scale.value > 1.05) reset();
      else {
        scale.value = withTiming(2.5);
        savedScale.value = 2.5;
        runOnJS(setZoom)(true);
      }
    });

  // Zoomed: move the photo, kept within its own enlarged bounds.
  const pan = Gesture.Pan()
    .enabled(zoomed)
    .onUpdate((e) => {
      const maxX = ((scale.value - 1) * width) / 2;
      const maxY = ((scale.value - 1) * height) / 2;
      tx.value = Math.min(maxX, Math.max(-maxX, savedTx.value + e.translationX));
      ty.value = Math.min(maxY, Math.max(-maxY, savedTy.value + e.translationY));
    })
    .onEnd(() => {
      savedTx.value = tx.value;
      savedTy.value = ty.value;
    });

  // Not zoomed: a downward drag closes; sideways belongs to the pager.
  const dismiss = Gesture.Pan()
    .enabled(!zoomed)
    .activeOffsetY([-14, 14])
    .failOffsetX([-18, 18])
    .onUpdate((e) => {
      ty.value = Math.max(0, e.translationY);
    })
    .onEnd((e) => {
      if (e.translationY > 120 || e.velocityY > 900) runOnJS(onDismiss)();
      else ty.value = withTiming(0);
    });

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
    opacity: scale.value > 1 ? 1 : 1 - Math.min(0.5, ty.value / 600),
  }));

  return (
    <GestureDetector gesture={Gesture.Simultaneous(pinch, pan, dismiss, doubleTap)}>
      <Animated.View style={[{ width, height }, style]}>
        <Image
          source={{ uri }}
          style={StyleSheet.absoluteFill}
          resizeMode="contain"
          accessible
          accessibilityRole="image"
          accessibilityLabel={accessibilityLabel}
        />
      </Animated.View>
    </GestureDetector>
  );
}
