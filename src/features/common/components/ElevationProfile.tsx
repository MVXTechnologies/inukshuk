import {
  buildElevationProfile,
  interpolateTrackAtDistance,
  scrubProfileAtRatio,
  type TrackPointAt,
} from '@core/geo/track';
import type { TrackPoint } from '@core/models';
import { formatDistance, formatElevation, formatPace, formatSpeed } from '@lib/format';
import { Fragment, useMemo, useState } from 'react';
import {
  PanResponder,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from 'react-native';
import { Text, useTheme } from 'react-native-paper';
import Svg, {
  Circle,
  Defs,
  Line,
  LinearGradient,
  Path,
  Rect,
  Stop,
  Text as SvgText,
} from 'react-native-svg';

const CHART_HEIGHT = 140;

interface Props {
  points: readonly TrackPoint[];
  ascentM: number;
  descentM: number;
  /**
   * Reports the scrubbed position along the track (or null when released) so a
   * caller can sync a map marker. Computed from `points` via arc-length interp.
   */
  onScrub?: (at: TrackPointAt | null) => void;
  /** Persistent numbered note pins to draw along the profile (GPX editor). */
  markers?: readonly { distanceM: number; label: string }[];
  /** A persistent dashed cursor, e.g. where a new note will be anchored. */
  selectedDistanceM?: number | null;
}

// ---------------------------------------------------------------------------
// Colour ramps (shared by the curve stroke and the colourbar legend)
// ---------------------------------------------------------------------------

type RampStop = [number, number, number];

function rampColor(stops: RampStop[], t: number): string {
  const x = Math.max(0, Math.min(1, t));
  const pos = x * (stops.length - 1);
  const seg = Math.min(stops.length - 2, Math.floor(pos));
  const local = pos - seg;
  const a = stops[seg]!;
  const b = stops[seg + 1]!;
  const c = a.map((v, i) => Math.round(v + (b[i]! - v) * local));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/** Grade: steep descent = blue → flat = sage → steep climb = red. */
const GRADE_STOPS: RampStop[] = [
  [0x3b, 0x7c, 0xb8],
  [0x8a, 0xb0, 0x6c],
  [0xe0, 0xa1, 0x3c],
  [0xc6, 0x2f, 0x2f],
];

/** Grade colour domain (± %, clamped) — beyond this everything reads "steep". */
const GRADE_LIMIT = 25;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Catmull-Rom → cubic Bézier: the smooth curve through the sample points. */
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return '';
  let d = `M${pts[0]!.x.toFixed(1)} ${pts[0]!.y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[Math.min(pts.length - 1, i + 2)]!;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

/**
 * Elevation-vs-distance profile: the altitude curve (smoothed, soft area
 * fill) with its EDGE stroked in a metric colour — pace for timed trails, or
 * grade — and a labelled colourbar underneath so the colours are actually
 * interpretable. Touch and drag to scrub; a marker rides the line and the
 * readout shows elevation, distance, grade and pace at that point.
 */
export function ElevationProfile({
  points,
  ascentM,
  descentM,
  onScrub,
  markers = [],
  selectedDistanceM = null,
}: Props) {
  const theme = useTheme();
  const profile = useMemo(() => buildElevationProfile(points), [points]);
  const [width, setWidth] = useState(0);
  const [scrub, setScrub] = useState<number | null>(null);
  const [scrubAt, setScrubAt] = useState<TrackPointAt | null>(null);

  // Speed at each profile sample, + its range. Uses the recorded GPS speed
  // when present, else derives it from time between samples — so timed GPX
  // imports (which rarely carry a speed field) still get pace colouring.
  const speeds = useMemo<(number | undefined)[]>(() => {
    if (!profile.hasElevation) return [];
    const ats = profile.samples.map((s) => interpolateTrackAtDistance(points, s.distanceM));
    return profile.samples.map((s, i) => {
      const sp = ats[i]?.speed;
      if (sp !== undefined && Number.isFinite(sp) && sp >= 0) return sp;
      const prev = ats[i - 1];
      const cur = ats[i];
      if (i > 0 && prev?.time !== undefined && cur?.time !== undefined) {
        const dt = (cur.time - prev.time) / 1000;
        const dd = s.distanceM - profile.samples[i - 1]!.distanceM;
        if (dt > 0 && dd >= 0) return dd / dt;
      }
      return undefined;
    });
  }, [points, profile]);
  const speedRange = useMemo(() => {
    const vals = speeds.filter((v): v is number => v !== undefined && Number.isFinite(v) && v >= 0);
    if (vals.length < 2) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of vals) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return hi > lo ? { lo, hi } : null;
  }, [speeds]);

  const { samples, minElevationM, maxElevationM, totalDistanceM } = profile;
  const range = maxElevationM - minElevationM || 1;

  // The altitude edge is coloured by grade; pace draws as its own second
  // curve in the same figure (dual-axis, up = faster) whenever the trail has
  // timing — no mode toggle, all three at once.
  const showPace = speedRange !== null;

  const pts =
    width > 0
      ? samples.map((s) => ({
          x: (s.distanceM / (totalDistanceM || 1)) * width,
          y: CHART_HEIGHT - ((s.elevationM - minElevationM) / range) * (CHART_HEIGHT - 14) - 6,
        }))
      : [];
  const linePath = smoothPath(pts);
  const areaPath =
    pts.length >= 2
      ? `${linePath} L${pts[pts.length - 1]!.x.toFixed(1)} ${CHART_HEIGHT} L${pts[0]!.x.toFixed(1)} ${CHART_HEIGHT} Z`
      : '';
  const xFor = (d: number) =>
    (Math.max(0, Math.min(d, totalDistanceM)) / (totalDistanceM || 1)) * width;

  /** Grade (%) of the sample segment ending at i, clamped for colouring. */
  const gradeAt = (i: number): number => {
    if (i === 0) return 0;
    const a = samples[i - 1];
    const b = samples[i];
    if (!a || !b) return 0;
    const dd = b.distanceM - a.distanceM;
    return dd > 0 ? ((b.elevationM - a.elevationM) / dd) * 100 : 0;
  };

  /** Grade colour of the segment ending at sample i. */
  const segmentColor = (i: number): string => {
    const g = gradeAt(i);
    return rampColor(GRADE_STOPS, (g + GRADE_LIMIT) / (2 * GRADE_LIMIT));
  };

  // Pace curve: speed mapped so UP = faster (the Strava idiom), broken where
  // no timing exists, sharing the distance axis with the altitude curve.
  const pacePts: { x: number; y: number }[][] = [];
  if (showPace && speedRange && width > 0) {
    let run: { x: number; y: number }[] = [];
    samples.forEach((smp, i) => {
      const sp = speeds[i];
      if (sp === undefined || !Number.isFinite(sp)) {
        if (run.length >= 2) pacePts.push(run);
        run = [];
        return;
      }
      const t = (sp - speedRange.lo) / (speedRange.hi - speedRange.lo);
      run.push({
        x: (smp.distanceM / (totalDistanceM || 1)) * width,
        y: CHART_HEIGHT - 14 - t * (CHART_HEIGHT - 40) - 6,
      });
    });
    if (run.length >= 2) pacePts.push(run);
  }

  // Elevation gridlines: three round-number levels between min and max.
  const gridLevels = useMemo(() => {
    const step = range / 4;
    const nice = 10 ** Math.floor(Math.log10(step || 1));
    const inc = Math.max(nice, Math.ceil(step / nice) * nice);
    const out: number[] = [];
    for (let e = Math.ceil(minElevationM / inc) * inc; e < maxElevationM; e += inc) out.push(e);
    return out.slice(0, 4);
  }, [minElevationM, maxElevationM, range]);

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  // Drive scrubbing through a PanResponder. It claims the gesture on touch and
  // refuses to yield it (onPanResponderTerminationRequest=false) while blocking
  // the native responder, so a parent ScrollView can't hijack the touch when the
  // finger drifts vertically — scrubbing keeps working off-axis.
  const pan = useMemo(() => {
    const onTouch = (e: GestureResponderEvent) => {
      if (width <= 0) return;
      const res = scrubProfileAtRatio(points, samples, e.nativeEvent.locationX / width);
      if (!res) return;
      setScrub(res.sampleIndex);
      setScrubAt(res.at);
      onScrub?.(res.at);
    };
    const endScrub = () => {
      setScrub(null);
      setScrubAt(null);
      onScrub?.(null);
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: onTouch,
      onPanResponderMove: onTouch,
      onPanResponderRelease: endScrub,
      onPanResponderTerminate: endScrub,
    });
  }, [width, samples, points, onScrub]);

  // Guard every index read: `scrub` indexes a PREVIOUS render's samples.
  const active = scrub === null ? null : (samples[scrub] ?? null);
  const marker = scrub === null ? null : (pts[scrub] ?? null);
  const grade = scrub === null || scrub === 0 ? null : gradeAt(scrub);

  const lineColor = theme.colors.primary;
  const activeSpeed =
    scrub !== null && speeds[scrub] !== undefined && Number.isFinite(speeds[scrub])
      ? speeds[scrub]
      : scrubAt?.speed;

  if (!profile.hasElevation) {
    return (
      <View style={styles.container}>
        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
          No elevation data was recorded for this trail.
        </Text>
      </View>
    );
  }

  const BAR_H = 8;

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text variant="labelMedium" style={{ color: theme.colors.primary }}>
          ↑ {formatElevation(ascentM)}
        </Text>
        <Text variant="labelMedium" style={{ color: theme.colors.error }}>
          ↓ {formatElevation(descentM)}
        </Text>
        <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
          {formatElevation(minElevationM)}–{formatElevation(maxElevationM)}
        </Text>
      </View>

      <View style={styles.readout}>
        {active ? (
          <Text variant="bodySmall" style={{ color: theme.colors.primary }}>
            {formatElevation(active.elevationM)} @ {formatDistance(active.distanceM)}
            {grade !== null ? ` · ${grade >= 0 ? '+' : ''}${grade.toFixed(0)}%` : ''}
            {activeSpeed !== undefined && activeSpeed > 0
              ? ` · ${formatPace(activeSpeed)} · ${formatSpeed(activeSpeed)}`
              : ''}
          </Text>
        ) : (
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            Touch the graph to read elevation
          </Text>
        )}
      </View>

      <View
        style={[styles.chart, { backgroundColor: theme.colors.surfaceVariant }]}
        onLayout={onLayout}
        {...pan.panHandlers}
      >
        {width > 0 && (
          <Svg width={width} height={CHART_HEIGHT}>
            <Defs>
              <LinearGradient id="elevFill" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={lineColor} stopOpacity={0.35} />
                <Stop offset="1" stopColor={lineColor} stopOpacity={0.06} />
              </LinearGradient>
            </Defs>

            {/* Altitude: the smooth shape with a quiet fill... */}
            <Path d={areaPath} fill="url(#elevFill)" />

            {/* Elevation gridlines with labels, inside the frame. */}
            {gridLevels.map((e) => {
              const y = CHART_HEIGHT - ((e - minElevationM) / range) * (CHART_HEIGHT - 14) - 6;
              return (
                <Fragment key={`g${e}`}>
                  <Line
                    x1={0}
                    y1={y}
                    x2={width}
                    y2={y}
                    stroke={theme.colors.onSurface}
                    strokeWidth={0.5}
                    opacity={0.12}
                  />
                  <SvgText
                    x={4}
                    y={y - 2.5}
                    fontSize={8}
                    fill={theme.colors.onSurfaceVariant}
                    textAnchor="start"
                    opacity={0.8}
                  >
                    {formatElevation(e)}
                  </SvgText>
                </Fragment>
              );
            })}

            {/* ...and the metric riding its edge: pace or grade, segment by
                segment along the curve. */}
            {pts.slice(1).map((p, i) => {
              const a = pts[i]!;
              return (
                <Line
                  key={`s${i}`}
                  x1={a.x}
                  y1={a.y}
                  x2={p.x}
                  y2={p.y}
                  stroke={segmentColor(i + 1)}
                  strokeWidth={3.5}
                  strokeLinecap="round"
                />
              );
            })}

            {/* Pace: the second curve, sharing the distance axis. */}
            {pacePts.map((run, i) => (
              <Path
                key={`pc${i}`}
                d={smoothPath(run)}
                stroke={theme.colors.tertiary}
                strokeWidth={2.2}
                strokeOpacity={0.95}
                fill="none"
              />
            ))}
            {showPace && speedRange && (
              <>
                <SvgText
                  x={width - 4}
                  y={16}
                  fontSize={8}
                  fill={theme.colors.tertiary}
                  textAnchor="end"
                >
                  {`fast ${formatPace(speedRange.hi)}`}
                </SvgText>
                <SvgText
                  x={width - 4}
                  y={CHART_HEIGHT - 6}
                  fontSize={8}
                  fill={theme.colors.tertiary}
                  textAnchor="end"
                >
                  {`slow ${formatPace(speedRange.lo)}`}
                </SvgText>
              </>
            )}

            {/* Persistent cursor: where a new note will be anchored. */}
            {selectedDistanceM != null && (
              <Line
                x1={xFor(selectedDistanceM)}
                y1={0}
                x2={xFor(selectedDistanceM)}
                y2={CHART_HEIGHT}
                stroke={theme.colors.error}
                strokeWidth={1.5}
                strokeDasharray="3,3"
              />
            )}

            {/* Persistent numbered note pins along the trail. */}
            {markers.map((m, i) => {
              const x = xFor(m.distanceM);
              return (
                <Fragment key={`mk${i}`}>
                  <Line
                    x1={x}
                    y1={16}
                    x2={x}
                    y2={CHART_HEIGHT}
                    stroke={lineColor}
                    strokeWidth={1}
                    opacity={0.25}
                  />
                  <Circle cx={x} cy={10} r={8} fill={lineColor} />
                  <SvgText
                    x={x}
                    y={13.5}
                    fontSize={9}
                    fontWeight="bold"
                    fill={theme.colors.onPrimary}
                    textAnchor="middle"
                  >
                    {m.label}
                  </SvgText>
                </Fragment>
              );
            })}

            {marker && (
              <>
                <Line
                  x1={marker.x}
                  y1={0}
                  x2={marker.x}
                  y2={CHART_HEIGHT}
                  stroke={lineColor}
                  strokeWidth={1}
                  opacity={0.5}
                />
                <Circle
                  cx={marker.x}
                  cy={marker.y}
                  r={5.5}
                  fill={lineColor}
                  stroke={theme.colors.onPrimary}
                  strokeWidth={1.5}
                />
              </>
            )}
          </Svg>
        )}
      </View>

      {/* The colourbar: what the altitude edge's colours MEAN (grade), plus a
          swatch for the pace curve when it's plotted. */}
      <View style={styles.legendBlock}>
        {width > 0 && (
          <Svg width={width} height={BAR_H}>
            <Defs>
              <LinearGradient id="legend" x1="0" y1="0" x2="1" y2="0">
                {GRADE_STOPS.map((stop, i, arr) => (
                  <Stop
                    key={`l${i}`}
                    offset={i / (arr.length - 1)}
                    stopColor={`rgb(${stop[0]},${stop[1]},${stop[2]})`}
                  />
                ))}
              </LinearGradient>
            </Defs>
            <Rect x={0} y={0} width={width} height={BAR_H} rx={BAR_H / 2} fill="url(#legend)" />
          </Svg>
        )}
        <View style={styles.legendLabels}>
          <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
            −{GRADE_LIMIT}% descent
          </Text>
          <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
            Grade
          </Text>
          <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
            climb +{GRADE_LIMIT}%
          </Text>
        </View>
        {showPace && (
          <View style={styles.paceLegend}>
            <View style={[styles.paceSwatch, { backgroundColor: theme.colors.tertiary }]} />
            <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
              Pace (up = faster)
            </Text>
          </View>
        )}
      </View>

      <View style={styles.axisRow}>
        <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
          0
        </Text>
        <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
          {formatDistance(totalDistanceM / 2)}
        </Text>
        <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
          {formatDistance(totalDistanceM)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 12, paddingTop: 4, paddingBottom: 10, gap: 8 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between' },
  readout: { minHeight: 18 },
  chart: { height: CHART_HEIGHT, borderRadius: 10, overflow: 'hidden' },
  legendBlock: { gap: 3 },
  legendLabels: { flexDirection: 'row', justifyContent: 'space-between' },
  paceLegend: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  paceSwatch: { width: 18, height: 3, borderRadius: 1.5 },
  axisRow: { flexDirection: 'row', justifyContent: 'space-between' },
});
