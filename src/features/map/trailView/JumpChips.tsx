import type { OutingAnalysis } from '@core/geo/track';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';

export interface JumpMark {
  id: 'start' | 'steepest' | 'summit' | 'end';
  label: string;
  distanceM: number;
}

/**
 * The quick-jump chips: Start · Steepest · Summit · End (the ones this trail
 * has). Steepest is the steepest climb, or the steepest descent on a trail
 * that never climbs steeply.
 */
export function jumpMarks(analysis: OutingAnalysis | null, minSummitRiseM = 30): JumpMark[] {
  if (!analysis || analysis.axis.cumM.length < 2) return [];
  const { axis, steepest, extremes } = analysis;
  const steep = steepest.climb ?? steepest.descent;
  const marks: JumpMark[] = [{ id: 'start', label: 'Start', distanceM: 0 }];
  if (steep) {
    marks.push({ id: 'steepest', label: 'Steepest', distanceM: axis.cumM[steep.startIndex] ?? 0 });
  }
  if (extremes && extremes.highM - extremes.lowM >= minSummitRiseM) {
    marks.push({ id: 'summit', label: 'Summit', distanceM: axis.cumM[extremes.highIndex] ?? 0 });
  }
  marks.push({ id: 'end', label: 'End', distanceM: axis.totalM });
  return marks;
}

interface Props {
  marks: readonly JumpMark[];
  cursorDistanceM: number | null;
  onJump: (distanceM: number) => void;
}

/** A row of chips; the one whose landmark is under the cursor reads as selected. */
export function JumpChips({ marks, cursorDistanceM, onJump }: Props) {
  const t = useSchemeTokens();
  if (marks.length === 0) return null;
  const activeId =
    cursorDistanceM === null
      ? null
      : (marks.find((m) => Math.abs(m.distanceM - cursorDistanceM) < 1)?.id ?? null);
  return (
    <View style={styles.chips}>
      {marks.map((m) => {
        const on = m.id === activeId;
        return (
          <Pressable
            key={m.id}
            onPress={() => onJump(m.distanceM)}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`Jump to ${m.label}`}
            style={[
              styles.chip,
              {
                borderColor: on ? t.library.onMapBorder : t.outlineVariant,
                backgroundColor: on ? t.library.onMap : t.surface,
              },
            ]}
          >
            <Text style={[styles.chipText, { color: on ? t.library.onMapInk : t.ink }]}>
              {m.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', gap: 8 },
  chip: {
    flexGrow: 1,
    flexBasis: 0,
    minHeight: 38,
    borderRadius: 10,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipText: { fontSize: 12.5, fontWeight: '700' },
});
