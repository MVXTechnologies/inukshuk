import { useEffect, useRef, useState } from 'react';
import { PanResponder, StyleSheet, View } from 'react-native';
import { Icon } from 'react-native-paper';

const SIZE = 56;

interface Props {
  /** The selected vertex on screen (map view coordinates, dp). */
  at: readonly [number, number];
  color: string;
  fill: string;
  /** The finger moved: the vertex should follow to this screen point. */
  onMove: (x: number, y: number) => void;
  /** Released here (or null: the gesture was taken away). */
  onEnd: (x: number, y: number) => void;
  onCancel: () => void;
}

/**
 * The selected vertex's drag grip (#502/#503): a finger-sized ring over the
 * point that takes the touch away from the map, so dragging it moves the
 * vertex instead of panning. The map reports the new coordinate on release
 * (`unproject`); while moving, the parent previews the shape.
 *
 * An RN responder over the map rather than a native draggable annotation —
 * those never received the finger on Android (the map's gestures won).
 */
export function DragHandle({ at, color, fill, onMove, onEnd, onCancel }: Props) {
  const [offset, setOffset] = useState<[number, number]>([0, 0]);
  const cb = useRef({ onMove, onEnd, onCancel, at });
  useEffect(() => {
    cb.current = { onMove, onEnd, onCancel, at };
  });
  // The initializer only CAPTURES the stable ref; every `.current` access
  // happens inside responder callbacks, never during render (the RangeSlider
  // / useDragToFolder pattern).
  // eslint-disable-next-line react-hooks/refs
  const [responder] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_, g) => {
        setOffset([g.dx, g.dy]);
        const [x, y] = cb.current.at;
        cb.current.onMove(x + g.dx, y + g.dy);
      },
      onPanResponderRelease: (_, g) => {
        setOffset([0, 0]);
        const [x, y] = cb.current.at;
        // A tap on the grip (no movement) is not a move.
        if (Math.hypot(g.dx, g.dy) < 3) cb.current.onCancel();
        else cb.current.onEnd(x + g.dx, y + g.dy);
      },
      onPanResponderTerminate: () => {
        setOffset([0, 0]);
        cb.current.onCancel();
      },
    }),
  );
  return (
    <View
      {...responder.panHandlers}
      style={[
        styles.grip,
        {
          left: at[0] - SIZE / 2 + offset[0],
          top: at[1] - SIZE / 2 + offset[1],
          borderColor: color,
        },
      ]}
      accessibilityRole="adjustable"
      accessibilityLabel="Drag to move the selected point"
      testID="draw-drag-handle"
    >
      <View style={[styles.badge, { backgroundColor: fill, borderColor: color }]}>
        <Icon source="cursor-move" size={14} color={color} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  grip: {
    position: 'absolute',
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    borderWidth: 2,
    borderStyle: 'dashed',
    zIndex: 8,
  },
  badge: {
    position: 'absolute',
    right: -6,
    top: -6,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
