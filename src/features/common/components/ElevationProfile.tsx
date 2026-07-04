import {
  buildElevationProfile,
  interpolateTrackAtDistance,
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

/** Pace colour ramp: 0 = slow (red) → 0.5 = amber → 1 = fast (green). */
function paceColor(t: number): string {
  const stops = [
    [0xd7, 0x30, 0x27],
    [0xfd, 0xae, 0x61],
    [0x1a, 0x98, 0x50],
  ];
  const x = Math.max(0, Math.min(1, t));
  const seg = x < 0.5 ? 0 : 1;
  const local = x < 0.5 ? x / 0.5 : (x - 0.5) / 0.5;
  const a = stops[seg]!;
  const b = stops[seg + 1]!;
  const c = a.map((v, i) => Math.round(v + (b[i]! - v) * local));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/** Build SVG path `d` strings (line + closed area) from screen-space points. */
function buildPaths(
  pts: { x: number; y: number }[],
  height: number,
): { line: string; area: string } {
  if (pts.length < 2) return { line: '', area: '' };
  const line = pts
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ');
  const area = `${line} L${pts[pts.length - 1]!.x.toFixed(1)} ${height} L${pts[0]!.x.toFixed(1)} ${height} Z`;
  return { line, area };
}

/**
 * Elevation-vs-distance profile rendered with react-native-svg: a smooth line
 * with a gradient fill or a grid backdrop (user-selectable, persisted). Touch and
 * drag to scrub — a marker rides the line and the readout shows elevation,
 * distance and grade at that point.
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

  // Speed at each profile sample (for the 'pace' colouring), + its range. Uses the
  // recorded GPS speed when present, else derives it from the time elapsed between
  // adjacent samples — so timed GPX imports (which rarely carry a speed field)
  // still get a pace gradient instead of falling back to the plain elevation fill.
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
  const lastIdx = samples.length - 1;

  const pts =
    width > 0
      ? samples.map((s) => ({
          x: (s.distanceM / (totalDistanceM || 1)) * width,
          y: CHART_HEIGHT - ((s.elevationM - minElevationM) / range) * (CHART_HEIGHT - 6) - 3,
        }))
      : [];
  const paths = buildPaths(pts, CHART_HEIGHT);
  const xFor = (d: number) =>
    (Math.max(0, Math.min(d, totalDistanceM)) / (totalDistanceM || 1)) * width;

  // Hachure ticks: faint vertical strokes from the curve to the baseline, spaced
  // closer where the grade is steeper — a topographic-style steepness cue.
  const ticks: { x: number; y: number }[] = [];
  const BASE_SPACING = 11;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const seg = b.x - a.x;
    if (seg <= 0) continue;
    const steep = Math.min(5, Math.abs(b.y - a.y) / seg);
    const spacing = BASE_SPACING / (1 + steep * 2.2);
    for (let x = a.x; x < b.x; x += spacing) {
      ticks.push({ x, y: a.y + (b.y - a.y) * ((x - a.x) / seg) });
    }
  }

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  // Drive scrubbing through a PanResponder. It claims the gesture on touch and
  // refuses to yield it (onPanResponderTerminationRequest=false) while blocking
  // the native responder, so a parent ScrollView can't hijack the touch when the
  // finger drifts vertically — scrubbing keeps working off-axis. The View holds
  // the responder for the whole gesture, so rebinding handlers per render is
  // safe (scrub position is read from locationX, not from gesture-state deltas).
  const pan = useMemo(() => {
    const onTouch = (e: GestureResponderEvent) => {
      if (width <= 0 || samples.length === 0) return;
      const ratio = Math.max(0, Math.min(1, e.nativeEvent.locationX / width));
      const idx = Math.min(lastIdx, Math.max(0, Math.round(ratio * lastIdx)));
      const s = samples[idx];
      if (!s) return;
      setScrub(idx);
      const at = interpolateTrackAtDistance(points, s.distanceM);
      setScrubAt(at);
      onScrub?.(at);
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
  }, [width, lastIdx, samples, points, onScrub]);

  // Guard every index read: `scrub` is an index into a PREVIOUS render's
  // samples; if `points` (and thus `samples`) shrinks before the next render,
  // a bare `samples[scrub]!` would be undefined and crash on `.elevationM`.
  const active = scrub === null ? null : (samples[scrub] ?? null);
  const marker = scrub === null ? null : (pts[scrub] ?? null);
  // Grade between the scrubbed sample and the previous one.
  const grade =
    scrub === null || scrub === 0
      ? null
      : (() => {
          const a = samples[scrub - 1];
          const b = samples[scrub];
          if (!a || !b) return null;
          const dd = b.distanceM - a.distanceM;
          return dd > 0 ? ((b.elevationM - a.elevationM) / dd) * 100 : 0;
        })();

  const lineColor = theme.colors.primary;
  // Pace at the scrubbed point: the same per-sample speed that colours the
  // gradient (GPS speed, or derived from time), so the readout shows pace even
  // for trails without a recorded speed field.
  const activeSpeed =
    scrub !== null && speeds[scrub] !== undefined && Number.isFinite(speeds[scrub])
      ? speeds[scrub]
      : scrubAt?.speed;

  // Rendered after all hooks so hook order stays stable across trails with and
  // without elevation data.
  if (!profile.hasElevation) {
    return (
      <View style={styles.container}>
        <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
          No elevation data was recorded for this trail.
        </Text>
      </View>
    );
  }

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
              {/* Pace fill: a horizontal gradient coloured by speed at each sample
                  (red slow → green fast), painting the whole elevation area. */}
              {speedRange && (
                <LinearGradient
                  id="paceFill"
                  x1="0"
                  y1="0"
                  x2={width}
                  y2="0"
                  gradientUnits="userSpaceOnUse"
                >
                  {samples.map((s, i) => {
                    const sp = speeds[i];
                    const t =
                      sp === undefined
                        ? 0.5
                        : (sp - speedRange.lo) / (speedRange.hi - speedRange.lo);
                    return (
                      <Stop
                        key={`p${i}`}
                        offset={s.distanceM / (totalDistanceM || 1)}
                        stopColor={paceColor(t)}
                        stopOpacity={0.92}
                      />
                    );
                  })}
                </LinearGradient>
              )}
              <LinearGradient id="elevFill" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={lineColor} stopOpacity={0.6} />
                <Stop offset="1" stopColor={lineColor} stopOpacity={0.28} />
              </LinearGradient>
            </Defs>

            {/* Solid fill: pace gradient when speed is known, else the elevation
                gradient — plus a crisp line tracing the profile edge. */}
            <Path d={paths.area} fill={speedRange ? 'url(#paceFill)' : 'url(#elevFill)'} />

            {/* Steepness hachures: denser strokes on steeper ground. */}
            {ticks.map((tk, i) => (
              <Line
                key={`hx${i}`}
                x1={tk.x}
                y1={tk.y}
                x2={tk.x}
                y2={CHART_HEIGHT}
                stroke={theme.colors.onSurface}
                strokeWidth={0.75}
                opacity={0.13}
              />
            ))}
            <Path
              d={paths.line}
              stroke={speedRange ? theme.colors.onSurface : lineColor}
              strokeWidth={2}
              strokeOpacity={speedRange ? 0.5 : 1}
              fill="none"
            />

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
                  {/* onPrimary, not #fff: dark mode's primary is a light sage and
                      white numerals vanish on it (theme.test.ts gates the pair). */}
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
                  r={5}
                  fill={lineColor}
                  stroke={theme.colors.onPrimary}
                  strokeWidth={1.5}
                />
              </>
            )}
          </Svg>
        )}
      </View>

      <View style={styles.axisRow}>
        <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
          0
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
  axisRow: { flexDirection: 'row', justifyContent: 'space-between' },
});
