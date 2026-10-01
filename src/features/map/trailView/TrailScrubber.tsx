import { formatClockTime } from '@core/format';
import { gradeAtDistance, type OutingAnalysis, type TrackPointAt } from '@core/geo/track';
import { formatGradePct } from '@core/library/trailViewText';
import type { TrackPoint } from '@core/models';
import { formatDistance, formatElevation } from '@state/formatters';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import { ElevationProfile } from '../../common/components/ElevationProfile';

export interface JumpMark {
  id: 'start' | 'steepest' | 'summit' | 'end';
  label: string;
  distanceM: number;
}

/** The quick-jump chips: Start · Steepest · Summit · End (the ones this trail has). */
export function jumpMarks(analysis: OutingAnalysis | null, minSummitRiseM = 30): JumpMark[] {
  if (!analysis || analysis.axis.cumM.length < 2) return [];
  const { axis, steepest, extremes } = analysis;
  const marks: JumpMark[] = [{ id: 'start', label: 'Start', distanceM: 0 }];
  if (steepest) {
    marks.push({
      id: 'steepest',
      label: 'Steepest',
      distanceM: axis.cumM[steepest.startIndex] ?? 0,
    });
  }
  if (extremes && extremes.highM - extremes.lowM >= minSummitRiseM) {
    marks.push({ id: 'summit', label: 'Summit', distanceM: axis.cumM[extremes.highIndex] ?? 0 });
  }
  marks.push({ id: 'end', label: 'End', distanceM: axis.totalM });
  return marks;
}

interface Props {
  points: readonly TrackPoint[];
  analysis: OutingAnalysis | null;
  ascentM: number;
  descentM: number;
  scrub: TrackPointAt | null;
  onScrub: (at: TrackPointAt | null) => void;
  /** Jump the cursor (and the map marker) to a distance along the trail. */
  onJump: (distanceM: number) => void;
  markers: readonly { distanceM: number; label: string }[];
  /** False for an untimed route: the readout has no time. */
  timed: boolean;
}

/**
 * The always-visible scrubber under the map (#511, board C): a live readout
 * (distance · elevation · grade · time at the cursor), the elevation profile
 * whose cursor drives the map marker, and quick-jump chips to the trail's
 * landmarks.
 */
export function TrailScrubber({
  points,
  analysis,
  ascentM,
  descentM,
  scrub,
  onScrub,
  onJump,
  markers,
  timed,
}: Props) {
  const t = useSchemeTokens();
  const marks = jumpMarks(analysis);
  const grade = scrub && analysis ? gradeAtDistance(points, analysis.axis, scrub.distanceM) : null;
  // The chip whose landmark sits under the cursor reads as selected.
  const activeId =
    scrub === null
      ? null
      : (marks.find((m) => Math.abs(m.distanceM - scrub.distanceM) < 1)?.id ?? null);

  return (
    <View style={[styles.wrap, { backgroundColor: t.surface }]} testID="trail-scrubber">
      <View style={styles.readout} accessibilityLiveRegion="polite">
        {scrub ? (
          <>
            <Text style={[styles.read, { color: t.ink }]}>{formatDistance(scrub.distanceM)}</Text>
            {scrub.elevation !== undefined && (
              <Text style={[styles.read, { color: t.ink }]}>
                {formatElevation(scrub.elevation)}
              </Text>
            )}
            {grade !== null && (
              <Text style={[styles.read, { color: t.data.route }]}>{formatGradePct(grade)}</Text>
            )}
            {timed && scrub.time !== undefined && (
              <Text style={[styles.read, { color: t.inkMuted }]} testID="scrub-time">
                {formatClockTime(scrub.time)}
              </Text>
            )}
          </>
        ) : (
          <Text variant="bodySmall" style={{ color: t.inkMuted }}>
            Drag the profile to move the marker on the map.
          </Text>
        )}
      </View>
      <ElevationProfile
        points={points}
        ascentM={ascentM}
        descentM={descentM}
        markers={markers}
        selectedDistanceM={scrub?.distanceM ?? null}
        cursorStyle="solid"
        showReadout={false}
        onScrub={onScrub}
      />
      {marks.length > 0 && (
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
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingTop: 10 },
  readout: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 12,
    minHeight: 22,
    paddingHorizontal: 14,
    alignItems: 'center',
  },
  read: { fontSize: 13, fontWeight: '700' },
  chips: { flexDirection: 'row', gap: 6, paddingHorizontal: 14, paddingBottom: 10 },
  chip: {
    flexGrow: 1,
    flexBasis: 0,
    minHeight: 36,
    borderRadius: 10,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipText: { fontSize: 12.5, fontWeight: '700' },
});
