import type { RecorderStatus } from '@state/recorderStore';
import { Pressable, StyleSheet, View } from 'react-native';
import { FAB, Icon, Text, useTheme } from 'react-native-paper';
import { InukshukIcon } from './InukshukIcon';

interface RecordControlsProps {
  status: RecorderStatus;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onWaypoint: () => void;
}

/**
 * Active-recording controls: a split pill whose left half pauses/resumes the
 * recording and whose right half drops an inukshuk waypoint (active only while
 * recording), with a stop button alongside. The *start* entry point lives in the
 * map's "+" speed-dial (MapScreen), so this renders nothing while idle.
 */
export function RecordControls({
  status,
  onPause,
  onResume,
  onStop,
  onWaypoint,
}: RecordControlsProps) {
  const theme = useTheme();
  const recording = status === 'recording';

  // Idle has no inline controls — starting is handled by the map's "+" FAB.
  if (status === 'idle') return null;

  const left = recording
    ? { icon: 'pause', label: 'Pause', onPress: onPause, color: theme.colors.tertiary }
    : { icon: 'play', label: 'Resume', onPress: onResume, color: theme.colors.primary };
  const wpColor = recording ? theme.colors.primary : theme.colors.onSurfaceDisabled;

  return (
    <View style={styles.row}>
      <FAB
        icon="stop"
        size="medium"
        onPress={onStop}
        color={theme.colors.onError}
        style={{ backgroundColor: theme.colors.error }}
      />
      <View style={[styles.pill, { backgroundColor: theme.colors.elevation.level3 }]}>
        <Pressable
          style={styles.half}
          onPress={left.onPress}
          android_ripple={{ color: '#00000022' }}
          accessibilityRole="button"
          accessibilityLabel={left.label}
        >
          <Icon source={left.icon} size={22} color={left.color} />
          <Text variant="labelLarge" style={{ color: left.color }}>
            {left.label}
          </Text>
        </Pressable>
        <View style={[styles.divider, { backgroundColor: theme.colors.outlineVariant }]} />
        <Pressable
          style={[styles.half, !recording && styles.halfDisabled]}
          onPress={recording ? onWaypoint : undefined}
          disabled={!recording}
          android_ripple={{ color: '#00000022' }}
          accessibilityRole="button"
          accessibilityLabel="Add waypoint"
        >
          <InukshukIcon size={22} color={wpColor} />
          <Text variant="labelLarge" style={{ color: wpColor }}>
            Waypoint
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 28,
    overflow: 'hidden',
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  half: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 14,
    paddingHorizontal: 18,
  },
  halfDisabled: { opacity: 0.55 },
  divider: { width: StyleSheet.hairlineWidth, alignSelf: 'stretch', marginVertical: 8 },
});
