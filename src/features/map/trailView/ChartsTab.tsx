import { formatClockTime, formatSpan } from '@core/format';
import type { PhotoOnAxis } from '@core/photos/axis';
import { heartRateBands, sampleIndexAt, type ChartSeries } from '@core/geo/track';
import { laneCircleAt, layoutLane, photoOrdinal, type LaneCircle } from '@core/photos/lane';
import { formatDistance, formatElevation, formatPace, formatSpeed } from '@state/formatters';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import { photoFileUri } from '../../photos/photoUri';
import { PhotoLane } from './PhotoLane';
import { TrailChart } from './TrailChart';

interface Props {
  series: ChartSeries | null;
  /** 'pace' for foot activities, 'speed' for bike/ski/paddle. */
  display: 'pace' | 'speed';
  cursorDistanceM: number | null;
  onScrub: (distanceM: number) => void;
  /** Trail photos (#587, own + note photos), time order, on the view's axis: the photo lane. */
  photos?: readonly PhotoOnAxis[];
  onOpenPhoto?: (photoId: string) => void;
  /** The cursor caught a photo (or let go: null): the map rings it. */
  onCursorPhoto?: (photoId: string | null) => void;
}

const NO_PHOTOS: readonly PhotoOnAxis[] = [];

/**
 * Charts tab (#511, board C2): Elevation, Pace (or Speed) and Heart rate,
 * stacked and synced — dragging on any of them moves all three cursors, the
 * map marker and the readout. Pace breaks at stops, which are labelled; the
 * heart-rate chart shows light effort bands and only exists when the trail
 * carries heart rate; an untimed route keeps the elevation chart alone.
 *
 * Trail photos (#587, mockup 05) ride a lane above the first chart: circles
 * (stacks with a count) with leader lines down to the profile. Dragging near
 * one catches it — the cursor snaps to it, the map rings it, and the row
 * under the charts names it, one tap from the viewer.
 */
export function ChartsTab({
  series,
  display,
  cursorDistanceM,
  onScrub,
  photos = NO_PHOTOS,
  onOpenPhoto,
  onCursorPhoto,
}: Props) {
  const t = useSchemeTokens();
  const [laneW, setLaneW] = useState(0);
  const totalM = series?.totalM ?? 0;
  const circles = useMemo(() => layoutLane(photos, laneW, totalM), [photos, laneW, totalM]);

  // Snap the cursor onto a photo it passes within 12 pt of; tell the map
  // only when the caught photo changes (not on every drag frame).
  const lastCaught = useRef<string | null>(null);
  const scrub = useCallback(
    (distanceM: number) => {
      let hit: LaneCircle | undefined;
      if (circles.length > 0 && totalM > 0 && laneW > 0) {
        hit = laneCircleAt(circles, (distanceM / totalM) * laneW);
      }
      onScrub(hit ? hit.distanceM : distanceM);
      const id = hit ? hit.cover.id : null;
      if (id !== lastCaught.current) {
        lastCaught.current = id;
        onCursorPhoto?.(id);
      }
    },
    [circles, totalM, laneW, onScrub, onCursorPhoto],
  );

  const caught = useMemo(
    () =>
      cursorDistanceM === null
        ? undefined
        : circles.find((c) => Math.abs(c.distanceM - cursorDistanceM) < 0.5),
    [circles, cursorDistanceM],
  );

  if (!series) {
    return (
      <Text variant="bodySmall" style={[styles.pad, { color: t.inkMuted }]}>
        Drawing the charts…
      </Text>
    );
  }
  const i = cursorDistanceM === null ? null : sampleIndexAt(series, cursorDistanceM);
  const pick = (vals: readonly (number | null)[] | null) =>
    vals && i !== null ? (vals[i] ?? null) : null;
  const common = {
    distances: series.distances,
    totalM: series.totalM,
    cursorDistanceM,
    onScrub: scrub,
  };
  const charts: number = [series.elevation, series.speed, series.heartRate].filter(Boolean).length;

  const ele = pick(series.elevation);
  const speed = pick(series.speed);
  const hr = pick(series.heartRate);
  const speedText =
    i === null
      ? '—'
      : speed === null
        ? 'stopped'
        : display === 'speed'
          ? formatSpeed(speed)
          : formatPace(speed);

  const hasLane = photos.length > 0;
  const lane = hasLane ? (
    <PhotoLane
      circles={circles}
      caughtId={caught?.cover.id ?? null}
      onOpen={(id) => onOpenPhoto?.(id)}
    />
  ) : undefined;
  const guides = hasLane
    ? circles.flatMap((c) =>
        // One leader per photo, from its circle down to its spot on the profile.
        c.anchorXs.map((x) => ({
          fromX: c.x,
          distanceM: laneW > 0 ? (x / laneW) * totalM : 0,
          strong: c === caught,
        })),
      )
    : undefined;
  const laneProps = { above: lane, guides, onWidth: setLaneW };
  // The lane rides the first chart there is (elevation, unless the trail has no altitude).
  const laneOn = series.elevation ? 'elevation' : series.speed ? 'speed' : 'hr';

  const ordinal = caught
    ? photoOrdinal(
        photos.map((p) => p.photo),
        caught.cover.id,
      )
    : null;
  const caughtPhoto = caught?.cover;

  return (
    <View style={styles.wrap} testID="trail-charts">
      <Text style={[styles.hint, { color: t.inkMuted }]}>
        {charts > 1
          ? 'Drag on any chart: they all follow, and so does the map.'
          : 'Drag on the chart: the map follows.'}
      </Text>
      {series.elevation && (
        <TrailChart
          {...common}
          {...(laneOn === 'elevation' ? laneProps : {})}
          title="Elevation"
          valueText={ele === null ? '—' : formatElevation(ele)}
          values={series.elevation}
          color={palette.ochre}
          area
          plotHeight={hasLane ? 120 : 80}
          testID="chart-elevation"
        />
      )}
      {caughtPhoto && ordinal && (
        <Pressable
          onPress={() => onOpenPhoto?.(caughtPhoto.id)}
          accessibilityRole="button"
          accessibilityLabel={`Open photo ${ordinal.n} of ${ordinal.of}`}
          style={[
            styles.caught,
            { backgroundColor: t.elevation.level2, borderColor: t.outlineVariant },
          ]}
          testID="lane-caught-photo"
        >
          <Image source={{ uri: photoFileUri(caughtPhoto.thumb) }} style={styles.caughtThumb} />
          <View style={styles.caughtBody}>
            <Text style={[styles.caughtTitle, { color: t.ink }]} numberOfLines={1}>
              {caughtPhoto.caption?.trim() || `Photo ${ordinal.n}`}
            </Text>
            <Text style={[styles.caughtSub, { color: t.inkVariant }]} numberOfLines={1}>
              {[
                caughtPhoto.takenAt !== undefined ? formatClockTime(caughtPhoto.takenAt) : null,
                formatDistance(caught.distanceM),
                ele !== null ? formatElevation(ele) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
            <Text style={[styles.caughtSub, { color: t.inkMuted }]} numberOfLines={1}>
              {`Photo ${ordinal.n} of ${ordinal.of}${
                ordinal.of > 1 ? ' · drag to the next one' : ''
              }`}
            </Text>
          </View>
          <Icon source="chevron-right" size={24} color={t.inkVariant} />
        </Pressable>
      )}
      {series.speed && (
        <TrailChart
          {...common}
          {...(laneOn === 'speed' ? laneProps : {})}
          title={display === 'speed' ? 'Speed' : 'Pace'}
          valueText={speedText}
          values={series.speed}
          color={palette.puck}
          marks={series.stopMarks.map((m) => ({
            distanceM: m.distanceM,
            label: `${m.kind === 'pause' ? 'paused' : 'stop'} ${formatSpan(m.durationS)}`,
          }))}
          testID="chart-pace"
        />
      )}
      {series.heartRate && (
        <TrailChart
          {...common}
          {...(laneOn === 'hr' ? laneProps : {})}
          title="Heart rate"
          valueText={hr === null ? '—' : `${Math.round(hr)} bpm`}
          values={series.heartRate}
          color={t.explore.trail}
          bands={heartRateBands(series.heartRate).map((b, k) => ({
            from: b.fromBpm,
            to: b.toBpm,
            color: t.explore.trail,
            opacity: k === 0 ? 0.16 : 0.08,
          }))}
          footnote="From your watch or import. Bands: the top 10 % and 20 % of this outing's peak."
          testID="chart-hr"
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  pad: { padding: 16 },
  wrap: { paddingHorizontal: 16, paddingTop: 12, gap: 10 },
  hint: { fontSize: 12.5 },
  caught: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 10,
  },
  caughtThumb: { width: 64, height: 64, borderRadius: 10 },
  caughtBody: { flex: 1, gap: 2 },
  caughtTitle: { fontSize: 15, fontWeight: '800' },
  caughtSub: { fontSize: 12.5 },
});
