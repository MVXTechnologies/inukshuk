import {
  buildElevationProfile,
  interpolateTrackAtDistance,
  scrubProfileAtRatio,
  type TrackPointAt,
} from '@core/geo/track';
import type { TrackPoint } from '@core/models';
import { formatDistance, formatElevation, formatPace } from '@lib/format';
import { Fragment, useMemo, useState } from 'react';
import {
  PanResponder,
  Pressable,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from 'react-native';
import { Icon, Text, useTheme } from 'react-native-paper';
import Svg, {
  Circle,
  Defs,
  Line,
  LinearGradient,
  Path,
  Stop,
  Text as SvgText,
} from 'react-native-svg';

/** Height of the plot area (the tilted x-tick band hangs below it). */
const CHART_HEIGHT = 140;
/** Band under the plot for the 45°-tilted distance ticks. */
const X_AXIS_H = 30;
/** Left gutter reserved for the elevation labels, clear of the curve. */
const AXIS_LEFT = 38;

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
// Colours
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

// Fixed series colours (not themed): they must match their readout text and
// stay readable on the surfaceVariant chart panel in both colour schemes.
const PACE_COLOR = '#4E97C9';
const HR_COLOR = '#E0526A';
/** Active state for the series toggles — the requested light blue. */
const TOGGLE_ACTIVE = '#6FB1DC';

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

/** Round-number distance ticks: enough of them to be useful, never crowded. */
function distanceTicks(totalM: number): number[] {
  if (totalM <= 0) return [];
  const stepsM = [100, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000];
  const step = stepsM.find((s) => totalM / s <= 8) ?? 100_000;
  const out: number[] = [];
  for (let d = step; d < totalM; d += step) out.push(d);
  // Label the very end too, unless it would collide with the last round tick.
  if (out.length === 0 || totalM - out[out.length - 1]! > step * 0.4) out.push(totalM);
  return out;
}

/**
 * Elevation-vs-distance profile with up to three series sharing the distance
 * axis: the altitude curve (soft fill, edge stroked by grade colour), the pace
 * curve (up = faster) and the heart-rate curve — each behind its own toggle in
 * the header (mountain / shoe / heart, all on by default). Touch and drag to
 * scrub; the readout colours each value like its curve.
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
  // Series visibility (item 7): mountain / shoe / heart, all on by default.
  const [showElev, setShowElev] = useState(true);
  const [showPaceCurve, setShowPaceCurve] = useState(true);
  const [showHrCurve, setShowHrCurve] = useState(true);

  // Speed and heart rate at each profile sample. Speed prefers the recorded
  // GPS value and falls back to time-between-samples, so timed GPX imports
  // (which rarely carry a speed field) still get a pace curve.
  const { speeds, hrs } = useMemo(() => {
    if (!profile.hasElevation)
      return { speeds: [] as (number | undefined)[], hrs: [] as (number | undefined)[] };
    const ats = profile.samples.map((s) => interpolateTrackAtDistance(points, s.distanceM));
    const speeds = profile.samples.map((s, i) => {
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
    const hrs = ats.map((at) => {
      const hr = at?.heartRateBpm;
      return hr !== undefined && Number.isFinite(hr) && hr > 0 ? hr : undefined;
    });
    return { speeds, hrs };
  }, [points, profile]);

  const speedRange = useMemo(() => rangeOf(speeds), [speeds]);
  const hrRange = useMemo(() => rangeOf(hrs), [hrs]);

  const { samples, minElevationM, maxElevationM, totalDistanceM } = profile;
  const range = maxElevationM - minElevationM || 1;

  const hasPace = speedRange !== null;
  const hasHr = hrRange !== null;
  const drawElev = showElev;
  const drawPace = hasPace && showPaceCurve;
  const drawHr = hasHr && showHrCurve;

  const plotW = Math.max(0, width - AXIS_LEFT);
  const xFor = (d: number) =>
    AXIS_LEFT + (Math.max(0, Math.min(d, totalDistanceM)) / (totalDistanceM || 1)) * plotW;

  const pts =
    width > 0
      ? samples.map((s) => ({
          x: xFor(s.distanceM),
          y: CHART_HEIGHT - ((s.elevationM - minElevationM) / range) * (CHART_HEIGHT - 14) - 6,
        }))
      : [];
  const linePath = smoothPath(pts);
  const areaPath =
    pts.length >= 2
      ? `${linePath} L${pts[pts.length - 1]!.x.toFixed(1)} ${CHART_HEIGHT} L${pts[0]!.x.toFixed(1)} ${CHART_HEIGHT} Z`
      : '';

  /** Grade (%) of the sample segment ending at i, clamped for colouring. */
  const gradeAt = (i: number): number => {
    if (i === 0) return 0;
    const a = samples[i - 1];
    const b = samples[i];
    if (!a || !b) return 0;
    const dd = b.distanceM - a.distanceM;
    return dd > 0 ? ((b.elevationM - a.elevationM) / dd) * 100 : 0;
  };

  const gradeColor = (g: number): string =>
    rampColor(GRADE_STOPS, (g + GRADE_LIMIT) / (2 * GRADE_LIMIT));

  /** Secondary curve (pace / HR): normalized runs broken where data is absent. */
  const curveRuns = (
    vals: (number | undefined)[],
    lo: number,
    hi: number,
  ): { x: number; y: number }[][] => {
    const runs: { x: number; y: number }[][] = [];
    let run: { x: number; y: number }[] = [];
    samples.forEach((smp, i) => {
      const v = vals[i];
      if (v === undefined || !Number.isFinite(v)) {
        if (run.length >= 2) runs.push(run);
        run = [];
        return;
      }
      const t = hi > lo ? (v - lo) / (hi - lo) : 0.5;
      run.push({ x: xFor(smp.distanceM), y: CHART_HEIGHT - 14 - t * (CHART_HEIGHT - 40) - 6 });
    });
    if (run.length >= 2) runs.push(run);
    return runs;
  };
  const paceRuns =
    drawPace && speedRange && width > 0 ? curveRuns(speeds, speedRange.lo, speedRange.hi) : [];
  const hrRuns = drawHr && hrRange && width > 0 ? curveRuns(hrs, hrRange.lo, hrRange.hi) : [];

  // Elevation gridlines: three round-number levels between min and max.
  const gridLevels = useMemo(() => {
    const step = range / 4;
    const nice = 10 ** Math.floor(Math.log10(step || 1));
    const inc = Math.max(nice, Math.ceil(step / nice) * nice);
    const out: number[] = [];
    for (let e = Math.ceil(minElevationM / inc) * inc; e < maxElevationM; e += inc) out.push(e);
    return out.slice(0, 4);
  }, [minElevationM, maxElevationM, range]);

  const ticks = useMemo(() => distanceTicks(totalDistanceM), [totalDistanceM]);

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  // Drive scrubbing through a PanResponder. It claims the gesture on touch and
  // refuses to yield it (onPanResponderTerminationRequest=false) while blocking
  // the native responder, so a parent ScrollView can't hijack the touch when the
  // finger drifts vertically — scrubbing keeps working off-axis.
  const pan = useMemo(() => {
    const onTouch = (e: GestureResponderEvent) => {
      const plot = width - AXIS_LEFT;
      if (plot <= 0) return;
      const ratio = (e.nativeEvent.locationX - AXIS_LEFT) / plot;
      const res = scrubProfileAtRatio(points, samples, ratio);
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
  const activeHr = scrub !== null ? hrs[scrub] : undefined;

  if (!profile.hasElevation) {
    return (
      <View style={styles.container}>
        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
          No elevation data was recorded for this trail.
        </Text>
      </View>
    );
  }

  const svgH = CHART_HEIGHT + X_AXIS_H;
  const dim = theme.colors.onSurfaceVariant;

  const seriesToggle = (icon: string, on: boolean, toggle: () => void, label: string) => (
    <Pressable
      onPress={toggle}
      hitSlop={6}
      accessibilityRole="togglebutton"
      accessibilityState={{ checked: on }}
      accessibilityLabel={label}
      style={[styles.toggle, on && styles.toggleOn]}
    >
      <Icon source={icon} size={16} color={on ? TOGGLE_ACTIVE : dim} />
    </Pressable>
  );

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text variant="labelMedium" style={{ color: theme.colors.primary }}>
          ↑ {formatElevation(ascentM)}
        </Text>
        <Text variant="labelMedium" style={{ color: theme.colors.error }}>
          ↓ {formatElevation(descentM)}
        </Text>
        <Text variant="labelMedium" style={[styles.headerRange, { color: dim }]}>
          {formatElevation(minElevationM)}–{formatElevation(maxElevationM)}
        </Text>
        {/* Series toggles (top-right of the graph): mountain / shoe / heart. */}
        <View style={styles.toggles}>
          {seriesToggle(
            'image-filter-hdr',
            showElev,
            () => setShowElev((v) => !v),
            'Altitude curve',
          )}
          {hasPace &&
            seriesToggle(
              'shoe-print',
              showPaceCurve,
              () => setShowPaceCurve((v) => !v),
              'Pace curve',
            )}
          {hasHr &&
            seriesToggle(
              'heart-pulse',
              showHrCurve,
              () => setShowHrCurve((v) => !v),
              'Heart-rate curve',
            )}
        </View>
      </View>

      <View style={styles.readout}>
        {active ? (
          <Text variant="bodySmall">
            <Text variant="bodySmall" style={{ color: theme.colors.onSurface }}>
              {formatElevation(active.elevationM)} @ {formatDistance(active.distanceM)}
            </Text>
            {drawElev && grade !== null && (
              <Text variant="bodySmall" style={{ color: gradeColor(grade) }}>
                {`  ·  ${formatGrade(grade)}`}
              </Text>
            )}
            {drawPace && activeSpeed !== undefined && activeSpeed > 0 && (
              <Text variant="bodySmall" style={{ color: PACE_COLOR }}>
                {`  ·  ${formatPace(activeSpeed)}`}
              </Text>
            )}
            {drawHr && activeHr !== undefined && (
              <Text variant="bodySmall" style={{ color: HR_COLOR }}>
                {`  ·  ${Math.round(activeHr)} bpm`}
              </Text>
            )}
          </Text>
        ) : (
          <Text variant="bodySmall" style={{ color: dim }}>
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
          <Svg width={width} height={svgH}>
            <Defs>
              <LinearGradient id="elevFill" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={lineColor} stopOpacity={0.35} />
                <Stop offset="1" stopColor={lineColor} stopOpacity={0.06} />
              </LinearGradient>
            </Defs>

            {/* Altitude: the smooth shape with a quiet fill... */}
            {drawElev && <Path d={areaPath} fill="url(#elevFill)" />}

            {/* Elevation gridlines; labels live in the left gutter, clear of
                the curve. */}
            {drawElev &&
              gridLevels.map((e) => {
                const y = CHART_HEIGHT - ((e - minElevationM) / range) * (CHART_HEIGHT - 14) - 6;
                return (
                  <Fragment key={`g${e}`}>
                    <Line
                      x1={AXIS_LEFT}
                      y1={y}
                      x2={width}
                      y2={y}
                      stroke={theme.colors.onSurface}
                      strokeWidth={0.5}
                      opacity={0.12}
                    />
                    <SvgText
                      x={AXIS_LEFT - 5}
                      y={y + 2.5}
                      fontSize={8}
                      fill={dim}
                      textAnchor="end"
                      opacity={0.9}
                    >
                      {formatElevation(e)}
                    </SvgText>
                  </Fragment>
                );
              })}

            {/* ...with the grade riding its edge, segment by segment. */}
            {drawElev &&
              pts.slice(1).map((p, i) => {
                const a = pts[i]!;
                return (
                  <Line
                    key={`s${i}`}
                    x1={a.x}
                    y1={a.y}
                    x2={p.x}
                    y2={p.y}
                    stroke={gradeColor(gradeAt(i + 1))}
                    strokeWidth={3.5}
                    strokeLinecap="round"
                  />
                );
              })}

            {/* Pace: second curve sharing the distance axis, up = faster. */}
            {paceRuns.map((run, i) => (
              <Path
                key={`pc${i}`}
                d={smoothPath(run)}
                stroke={PACE_COLOR}
                strokeWidth={2.2}
                strokeOpacity={0.95}
                fill="none"
              />
            ))}
            {drawPace && speedRange && (
              <>
                <SvgText x={width - 4} y={16} fontSize={8} fill={PACE_COLOR} textAnchor="end">
                  {`fast ${formatPace(speedRange.hi)}`}
                </SvgText>
                <SvgText
                  x={width - 4}
                  y={CHART_HEIGHT - 6}
                  fontSize={8}
                  fill={PACE_COLOR}
                  textAnchor="end"
                >
                  {`slow ${formatPace(speedRange.lo)}`}
                </SvgText>
              </>
            )}

            {/* Heart rate: third curve, same normalized band. */}
            {hrRuns.map((run, i) => (
              <Path
                key={`hr${i}`}
                d={smoothPath(run)}
                stroke={HR_COLOR}
                strokeWidth={2}
                strokeOpacity={0.9}
                fill="none"
              />
            ))}
            {drawHr && hrRange && (
              // Top-left of the plot: the top-right corner belongs to the pace
              // "fast" label.
              <SvgText x={AXIS_LEFT + 4} y={16} fontSize={8} fill={HR_COLOR} textAnchor="start">
                {`${Math.round(hrRange.lo)}–${Math.round(hrRange.hi)} bpm`}
              </SvgText>
            )}

            {/* Distance ticks, tilted 45° in the band below the plot. */}
            <Line
              x1={AXIS_LEFT}
              y1={CHART_HEIGHT}
              x2={width}
              y2={CHART_HEIGHT}
              stroke={theme.colors.onSurface}
              strokeWidth={0.5}
              opacity={0.2}
            />
            {ticks.map((d) => {
              const x = xFor(d);
              return (
                <Fragment key={`t${d}`}>
                  <Line
                    x1={x}
                    y1={CHART_HEIGHT}
                    x2={x}
                    y2={CHART_HEIGHT + 4}
                    stroke={theme.colors.onSurface}
                    strokeWidth={0.5}
                    opacity={0.35}
                  />
                  <SvgText
                    x={x + 2}
                    y={CHART_HEIGHT + 12}
                    fontSize={8}
                    fill={dim}
                    textAnchor="start"
                    transform={`rotate(45 ${x + 2} ${CHART_HEIGHT + 12})`}
                  >
                    {formatDistance(d)}
                  </SvgText>
                </Fragment>
              );
            })}

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
    </View>
  );
}

/** Signed whole-percent grade, with -0 normalized so a flat reads "0%". */
function formatGrade(g: number): string {
  const r = Math.round(g) === 0 ? 0 : Math.round(g);
  return `${r > 0 ? '+' : ''}${r}%`;
}

/** Min/max over the defined values; null when fewer than 2 (no useful curve). */
function rangeOf(vals: (number | undefined)[]): { lo: number; hi: number } | null {
  let lo = Infinity;
  let hi = -Infinity;
  let n = 0;
  for (const v of vals) {
    if (v === undefined || !Number.isFinite(v) || v < 0) continue;
    n++;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return n >= 2 && hi > lo ? { lo, hi } : null;
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: 12, paddingTop: 4, paddingBottom: 10, gap: 8 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headerRange: { flexGrow: 1 },
  toggles: { flexDirection: 'row', gap: 6 },
  toggle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1.2,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  toggleOn: { borderColor: TOGGLE_ACTIVE },
  readout: { minHeight: 18 },
  chart: { height: CHART_HEIGHT + X_AXIS_H, borderRadius: 10, overflow: 'hidden' },
});
