import type { RecorderStatus } from '@state/recorderStore';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Icon, useTheme } from 'react-native-paper';
import { InukshukIcon } from './InukshukIcon';

interface RecordControlsProps {
  status: RecorderStatus;
  /** Mirrors StatsHud's own expanded/collapsed state (see MapScreen): collapsed
   * lays the three buttons out in a row beside the compact pill; expanded
   * stacks them vertically to the right of the (now smaller) stats card. */
  expanded: boolean;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onWaypoint: () => void;
}

/** Collapsed: bigger than the pill beside it, so the row it sits in
 * (center-aligned) makes the buttons visibly pop above/below the bar.
 * Expanded: smaller, matching the shrunk stats card. */
const COLLAPSED_SIZE = 48;
const EXPANDED_SIZE = 38;

interface CircleButtonProps {
  size: number;
  backgroundColor: string;
  onPress?: () => void;
  disabled?: boolean;
  accessibilityLabel: string;
  children: ReactNode;
}

/** A round, icon-only, no-label button — the building block for all three
 * recording controls (item 3: icons only, a11y labels retained). */
function CircleButton({
  size,
  backgroundColor,
  onPress,
  disabled,
  accessibilityLabel,
  children,
}: CircleButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      android_ripple={{ color: '#00000022', radius: size / 2 }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.circle,
        { width: size, height: size, borderRadius: size / 2, backgroundColor },
        disabled ? styles.circleDisabled : null,
      ]}
    >
      {children}
    </Pressable>
  );
}

/**
 * Active-recording controls: three icon-only round buttons — stop,
 * pause/resume, add waypoint (in that order) — no text labels (see item 3;
 * accessibilityLabels are unchanged from before this redesign so the .maestro
 * flows that target them by label — record.yaml/category-record.yaml/
 * heatmap.yaml via "Stop recording", waypoint.yaml's own dial button is
 * separate — keep working). The *start* entry point lives in the map's "+"
 * speed-dial (MapScreen), so this renders nothing while idle.
 */
export function RecordControls({
  status,
  expanded,
  onPause,
  onResume,
  onStop,
  onWaypoint,
}: RecordControlsProps) {
  const theme = useTheme();
  const recording = status === 'recording';

  // Idle has no inline controls — starting is handled by the map's "+" FAB.
  if (status === 'idle') return null;

  const size = expanded ? EXPANDED_SIZE : COLLAPSED_SIZE;
  const iconSize = expanded ? 18 : 24;

  const pauseResume = recording
    ? { icon: 'pause', label: 'Pause', onPress: onPause, color: theme.colors.tertiary }
    : { icon: 'play', label: 'Resume', onPress: onResume, color: theme.colors.primary };
  const wpColor = recording ? theme.colors.primary : theme.colors.onSurfaceDisabled;

  return (
    <View style={expanded ? styles.column : styles.row}>
      <CircleButton
        size={size}
        backgroundColor={theme.colors.error}
        onPress={onStop}
        accessibilityLabel="Stop recording"
      >
        <Icon source="stop" size={iconSize} color={theme.colors.onError} />
      </CircleButton>
      <CircleButton
        size={size}
        backgroundColor={theme.colors.elevation.level3}
        onPress={pauseResume.onPress}
        accessibilityLabel={pauseResume.label}
      >
        <Icon source={pauseResume.icon} size={iconSize} color={pauseResume.color} />
      </CircleButton>
      <CircleButton
        size={size}
        backgroundColor={theme.colors.elevation.level3}
        onPress={recording ? onWaypoint : undefined}
        disabled={!recording}
        accessibilityLabel="Add waypoint"
      >
        <InukshukIcon size={iconSize - 2} color={wpColor} />
      </CircleButton>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  column: { flexDirection: 'column', alignItems: 'center', gap: 8 },
  circle: {
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  circleDisabled: { opacity: 0.55 },
});
