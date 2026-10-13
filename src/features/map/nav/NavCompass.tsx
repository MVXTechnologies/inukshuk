import type { LatLng } from '@core/models';
import {
  chooseTapeSource,
  createCourseTracker,
  latchLow,
  ON_COURSE_IN_DEG,
  ON_COURSE_OUT_DEG,
  TAPE_HALF_SPAN_DEG,
  tapeLabelClear,
  tapeMarker,
  tapeTicks,
  turnHint,
  type CourseSample,
  type TapeSpan,
} from '@core/nav';
import { signedDeltaDeg } from '@core/signal/heading';
import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { memo, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import Svg, {
  Defs,
  G,
  LinearGradient,
  Line,
  Path,
  Rect,
  Stop,
  Text as SvgText,
} from 'react-native-svg';
import { subscribeHeading } from '../useCompass';
import { weatherChrome } from '../weather/weatherChrome';

/** The tape's height (owner 2026-10-13: a linear compass, ~44 dp). */
export const NAV_COMPASS_H = 44;
/** Left (distance) and right (turn hint) blocks either side of the tape, dp. */
const LEFT_W = 92;
const RIGHT_W = 96;
/**
 * Re-render only when the heading moved this much (°). The shared filter
 * already holds the heading dead still at rest, so this only keeps a turn
 * from re-rendering the tape on every sub-degree step.
 */
const MIN_HEADING_STEP_DEG = 1;
/** With no magnetometer, re-read the course this often so a stop hides the tape, ms. */
const COG_REFRESH_MS = 3000;

const SAGE = weatherChrome.accent;

export interface NavCompassProps {
  /** Latest fix: drives the course-over-ground fallback (no magnetometer). */
  location: LatLng | null;
  /** The sage flag: bearing from you to the target, degrees. */
  targetBearingDeg: number;
  /** The orange bar (following a trail): the trail's direction. Absent for a point. */
  trailBearingDeg?: number | null;
  /** Left, large: "1.23 km". */
  distance: string;
  /** Left, small: "042° NE", or "› Camp lac" while following. */
  detail: string;
  /**
   * Right side while following a trail ("On trail" / "Off trail 62 m").
   * Absent: the turn hint ("Right 62°") or "On course".
   */
  status?: { text: string; warn: boolean; spoken?: string } | null;
}

/**
 * The linear navigation compass (#672, #678): a 44 dp heading tape, the full
 * width of the map, just above the ⓘ + scale row. The scale scrolls under a
 * fixed centre index (where you face); the sage flag is the target's
 * bearing, pinned to the edge as an arrow beyond ±60°; while following a
 * trail an orange bar shows the trail's direction. Distance on the left, the
 * turn hint (or the trail status) on the right.
 *
 * Owns its heading subscription (`subscribeHeading`) so heading ticks
 * re-render this leaf only, never MapScreen; ≥1° steps only. With no
 * magnetometer the course over ground drives the tape above 0.5 m/s ("COG"),
 * and below that the tape hides rather than show a frozen scale.
 *
 * Map chrome: the scheme's chrome slab, the same dark slab as the rail in
 * both themes.
 */
export const NavCompass = memo(function NavCompass({
  location,
  targetBearingDeg,
  trailBearingDeg,
  distance,
  detail,
  status,
}: NavCompassProps) {
  const t = useSchemeTokens();
  const [width, setWidth] = useState(0);
  const [compassDeg, setCompassDeg] = useState<number | null>(null);
  const [course, setCourse] = useState<CourseSample>({ speedMps: 0, courseDeg: null });
  const courseRef = useRef(createCourseTracker());
  // Latched "on course" (in at 10°, out past 15°); see the render below.
  const [onCourseLatch, setOnCourseLatch] = useState(false);

  // The heading last rendered: sub-degree ticks are dropped here, before any
  // state update, so they cost no render at all.
  const shownHeadingRef = useRef<number | null>(null);
  useEffect(
    () =>
      subscribeHeading(({ headingDeg }) => {
        const prev = shownHeadingRef.current;
        if (prev !== null && Math.abs(signedDeltaDeg(prev, headingDeg)) < MIN_HEADING_STEP_DEG) {
          return;
        }
        shownHeadingRef.current = headingDeg;
        setCompassDeg(headingDeg);
      }),
    [],
  );

  // Course over ground, only while there is no compass to drive the tape.
  const noCompass = compassDeg === null;
  useEffect(() => {
    if (!noCompass || location === null) return;
    const push = () => {
      const next = courseRef.current.push(location, Date.now());
      setCourse((prev) =>
        prev.speedMps === next.speedMps && prev.courseDeg === next.courseDeg ? prev : next,
      );
    };
    push();
    // A watch can go quiet when you stop: re-reading the same fix lets the
    // speed decay below the threshold, so the tape hides instead of freezing.
    const id = setInterval(push, COG_REFRESH_MS);
    return () => clearInterval(id);
  }, [noCompass, location]);

  const source = chooseTapeSource(compassDeg, course);
  if (source === null) return null;
  const heading = source.headingDeg;

  const marker = tapeMarker(heading, targetBearingDeg);
  const following = status != null;
  // On course (point navigation only): in at 10°, out past 15°. Derived
  // during render from the previous latch (React's "adjust state while
  // rendering" pattern): no effect, no extra commit.
  const nextLatch = latchLow(
    onCourseLatch,
    Math.abs(marker.deltaDeg),
    ON_COURSE_IN_DEG,
    ON_COURSE_OUT_DEG,
  );
  if (nextLatch !== onCourseLatch) setOnCourseLatch(nextLatch);
  const onCourse = !following && nextLatch;
  const rightText = following ? status.text : onCourse ? 'On course' : turnHint(marker.deltaDeg);
  const rightColor = following
    ? status.warn
      ? t.map.gnssWarn
      : SAGE
    : onCourse
      ? SAGE
      : t.map.chromeInk;

  const tapeW = Math.max(0, width - LEFT_W - RIGHT_W);
  const H = NAV_COMPASS_H;
  const cx = tapeW / 2;
  const px = (offset: number) => cx + offset * (tapeW / 2);
  // What is drawn over the tick labels: a label under any of these is left
  // out rather than half covered (2.5.1 QA: the edge arrow on "300", the
  // flag and the bar stacked on "60", "COG" against "N").
  const blocked: TapeSpan[] = [];
  if (marker.kind === 'on') {
    const fx = px(marker.offset);
    blocked.push([fx - 8, fx + 8]);
  } else {
    blocked.push(marker.side === 'right' ? [tapeW - 16, tapeW] : [0, 16]);
  }
  if (trailBearingDeg != null) {
    const delta = signedDeltaDeg(heading, trailBearingDeg);
    if (Math.abs(delta) <= TAPE_HALF_SPAN_DEG) {
      const bx = px(delta / TAPE_HALF_SPAN_DEG);
      blocked.push([bx - 6, bx + 6]);
    }
  }
  if (source.kind === 'cog') blocked.push([0, 34]);

  return (
    <View
      style={[
        styles.slab,
        {
          backgroundColor: t.map.chrome,
          borderColor: onCourse ? SAGE : t.map.chromeDivider,
          borderWidth: onCourse ? 2.5 : 1,
          shadowColor: palette.shadow,
        },
      ]}
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
      accessible
      accessibilityLabel={`Navigation compass. ${distance}, ${detail}. ${following ? (status.spoken ?? status.text) : rightText}`}
      testID="nav-compass"
    >
      <View style={styles.left}>
        <Text style={[styles.distance, { color: t.map.chromeInk }]} numberOfLines={1}>
          {distance}
        </Text>
        <Text style={[styles.detail, { color: t.map.chromeInk }]} numberOfLines={1}>
          {detail}
        </Text>
      </View>
      <View style={styles.tape}>
        {tapeW > 0 && (
          <Svg width={tapeW} height={H}>
            <Defs>
              <LinearGradient id="navTapeFade" x1="0" y1="0" x2="1" y2="0">
                <Stop offset="0" stopColor={t.map.chrome} stopOpacity={1} />
                <Stop offset="0.12" stopColor={t.map.chrome} stopOpacity={0} />
                <Stop offset="0.88" stopColor={t.map.chrome} stopOpacity={0} />
                <Stop offset="1" stopColor={t.map.chrome} stopOpacity={1} />
              </LinearGradient>
            </Defs>
            {tapeTicks(heading).map((tick) => {
              const x = px(tick.offset);
              const len = tick.major ? 15 : tick.medium ? 11 : 9;
              return (
                <G key={tick.deg}>
                  <Line
                    x1={x}
                    y1={H - 6}
                    x2={x}
                    y2={H - len}
                    stroke={t.map.chromeInk}
                    strokeOpacity={tick.major ? 0.85 : 0.4}
                    strokeWidth={tick.major ? 1.5 : 1}
                  />
                  {tick.label !== null &&
                    x > 12 &&
                    x < tapeW - 12 &&
                    tapeLabelClear(x, tick.label, blocked) && (
                      <SvgText
                        testID={`nav-compass-label-${tick.deg}`}
                        x={x}
                        y={H - 19}
                        textAnchor="middle"
                        fontSize={tick.label.length === 1 ? 13 : 10.5}
                        fontWeight="800"
                        fill={tick.deg === 0 ? t.map.compassNorth : t.map.chromeInk}
                        fillOpacity={tick.label.length === 1 ? 1 : 0.7}
                      >
                        {tick.label}
                      </SvgText>
                    )}
                </G>
              );
            })}
            {trailBearingDeg != null && (
              <TrailBar heading={heading} bearing={trailBearingDeg} px={px} />
            )}
            {marker.kind === 'on' ? (
              <G testID="nav-compass-flag">
                <Rect
                  x={px(marker.offset) - 1}
                  y={4}
                  width={2}
                  height={H - 12}
                  fill={SAGE}
                  opacity={0.55}
                />
                <Path d={`M${px(marker.offset)} ${H - 4} l-7 -11 h14z`} fill={SAGE} />
              </G>
            ) : (
              <Path
                testID={`nav-compass-edge-${marker.side}`}
                d={
                  marker.side === 'right'
                    ? `M${tapeW - 14} 14 l12 8 l-12 8z`
                    : `M14 14 l-12 8 l12 8z`
                }
                fill={SAGE}
              />
            )}
            <Rect x={0} y={2} width={tapeW} height={H - 4} fill="url(#navTapeFade)" />
            <Path d={`M${cx} 11 l-6 -8 h12z`} fill={onCourse ? SAGE : t.map.chromeInk} />
            <Line x1={0.5} y1={8} x2={0.5} y2={H - 8} stroke={t.map.chromeDivider} />
            <Line
              x1={tapeW - 0.5}
              y1={8}
              x2={tapeW - 0.5}
              y2={H - 8}
              stroke={t.map.chromeDivider}
            />
          </Svg>
        )}
        {source.kind === 'cog' && (
          <Text style={[styles.cog, { color: t.map.chromeInk }]} testID="nav-compass-cog">
            COG
          </Text>
        )}
      </View>
      <View style={styles.right}>
        {/* The number is the point: shrink to fit rather than cut it off. */}
        <Text
          style={[styles.status, { color: rightColor }]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.7}
          testID="nav-compass-status"
        >
          {rightText}
        </Text>
      </View>
    </View>
  );
});

/** The orange trail-direction bar (#678), hidden while outside the window. */
function TrailBar({
  heading,
  bearing,
  px,
}: {
  heading: number;
  bearing: number;
  px: (offset: number) => number;
}) {
  const t = useSchemeTokens();
  const delta = signedDeltaDeg(heading, bearing);
  if (Math.abs(delta) > TAPE_HALF_SPAN_DEG) return null;
  const x = px(delta / TAPE_HALF_SPAN_DEG);
  const H = NAV_COMPASS_H;
  return (
    <G testID="nav-compass-trail-bar">
      <Rect x={x - 2} y={6} width={4} height={H - 12} rx={2} fill={palette.route} />
      <Path
        d={`M${x - 5} ${H / 2} a5 5 0 1 0 10 0 a5 5 0 1 0 -10 0`}
        fill={palette.route}
        stroke={t.map.chromeInk}
        strokeWidth={1.5}
      />
    </G>
  );
}

const styles = StyleSheet.create({
  slab: {
    height: NAV_COMPASS_H,
    borderRadius: NAV_COMPASS_H / 2,
    flexDirection: 'row',
    alignItems: 'center',
    overflow: 'hidden',
    elevation: 4,
    shadowOpacity: 0.32,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  left: { width: LEFT_W, paddingLeft: 16, paddingRight: 4 },
  distance: { fontSize: 16, lineHeight: 19, fontWeight: '800', fontVariant: ['tabular-nums'] },
  detail: { fontSize: 11, lineHeight: 14, fontWeight: '700', opacity: 0.62 },
  tape: { flex: 1, height: NAV_COMPASS_H },
  cog: {
    position: 'absolute',
    left: 6,
    top: 3,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.6,
    opacity: 0.7,
  },
  right: { width: RIGHT_W, paddingRight: 16, alignItems: 'flex-end' },
  status: { fontSize: 13, fontWeight: '800' },
});
