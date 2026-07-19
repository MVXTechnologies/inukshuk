import type { ReactNode } from 'react';
import { Animated, StyleSheet } from 'react-native';
import type { DragItem } from './useDragToFolder';

/** The floating chip that follows the finger during a drag (window coords). */
export function DragGhost({
  dragging,
  ghost,
  backgroundColor,
  color,
  renderLabel,
}: {
  dragging: DragItem | null;
  ghost: Animated.ValueXY;
  backgroundColor: string;
  color: string;
  renderLabel: (label: string, color: string) => ReactNode;
}) {
  if (!dragging) return null;
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        ghostStyles.chip,
        {
          backgroundColor,
          transform: [
            { translateX: Animated.subtract(ghost.x, 24) },
            { translateY: Animated.subtract(ghost.y, 64) },
          ],
        },
      ]}
    >
      {renderLabel(dragging.label, color)}
    </Animated.View>
  );
}

const ghostStyles = StyleSheet.create({
  chip: {
    position: 'absolute',
    top: 0,
    left: 0,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    elevation: 6,
    shadowOpacity: 0.3,
    shadowRadius: 6,
  },
});
