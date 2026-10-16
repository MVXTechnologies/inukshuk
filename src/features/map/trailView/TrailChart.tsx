import { scrubRatio } from '@core/chart/scrub';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Text } from '@ui/paper';
import Svg, { Circle, Line, Path, Rect, Text as SvgText } from 'react-native-svg';
import { useScaledStyles, useDisplayScale } from '@ui/displayScale';

export interface ChartBand {
  from: number;
  to: number;
  color: string;
  opacity: number;
}

interface Props {
  title: string;
  /** The value at the cursor (right of the title), or a hint. */
  valueText: string;
  distances: readonly number[];
  totalM: number;
  /** One value per distance; null breaks the line. */
  values: readonly (number | null)[];
  color: string;
  /** Fill under the line (elevation). */
  area?: boolean;
  plotHeight?: number;
  cursorDistanceM: number | null;
  /** Dragging on the chart: the distance under the finger. */
  onScrub: (distanceM: number) => void;
  /** Value-domain bands drawn behind the line (heart-rate effort). */
  bands?: readonly ChartBand[];
  /** Labelled vertical marks (stops). */
  marks?: readonly { distanceM: number; label: string }[];
  footnote?: string;
  testID?: string;
  /** Small ticks along the top of the plot (photo spots on the compact chart, #587). */
  dots?: readonly number[];
  /**
   * Thin leader lines from the top of the plot down to the line at these
   * distances (the photo lane's circles, #587); `strong` ones are the caught photo.
   */
  guides?: readonly { distanceM: number; fromX?: number; strong?: boolean }[];
  /** Drawn between the title row and the plot, as wide as the plot (the photo lane). */
  above?: ReactNode;
  /** Just the plot: no title row, no card padding (the trail view's folded peek, #740). */
  bare?: boolean;
  /** The plot's width, once laid out. */
  onWidth?: (width: number) => void;
}

const PAD_Y = 6;
const NONE: readonly never[] = [];

/**
 * Direction lock of the scrub (dp from touch-down). Sideways travel past
 * SCRUB_ACTIVATE_X makes the drag a scrub for good; vertical travel past
 * SCRUB_FAIL_Y first hands it to the page scroll. The 1:2 ratio keeps the
 * old "a drag at least twice as tall as it is wide scrolls" rule, decided once
 * at the start of the drag instead of re-judged on every frame.
 */
export const SCRUB_ACTIVATE_X = 8;
export const SCRUB_FAIL_Y = 16;

/**
 * One chart of the trail view (#511, board C2): a line over the trail's
 * distance with a shared cursor. Touch and drag anywhere on it to move the
 * cursor — the screen moves every chart's cursor, the map marker and the
 * readout with it. A drag that is mostly vertical is handed to the page
 * scroll instead, so the tab still scrolls over its charts.
 *
 * The drag is a gesture-handler Pan, direction-locked natively (see
 * SCRUB_ACTIVATE_X). It used to be a PanResponder that let the page scroll
 * take over (`onShouldBlockNativeResponder: false`): on Android the native
 * ScrollView then intercepted the touch as soon as the finger drifted ~8 dp
 * vertically from where it landed — however far it had scrubbed sideways —
 * and the cursor froze mid-drag; on iOS the hand-over test compared the NET
 * dx/dy, so scrubbing back towards the start (net dx ~ 0) yielded to the
 * smallest vertical wobble. Once this Pan is active the gesture-handler root
 * holds the touch, so neither scroll can take it back until the finger lifts.
 */
export function TrailChart({
  title,
  valueText,
  distances,
  totalM,
  values,
  color,
  area = false,
  plotHeight = 80,
  cursorDistanceM,
  onScrub,
  bands = [],
  marks = [],
  footnote,
  testID,
  dots = NONE,
  guides = NONE,
  above,
  bare = false,
  onWidth,
}: Props) {
  const styles = useScaledStyles(stylesSheet);

  const t = useSchemeTokens();
  const [width, setWidth] = useState(0);
  // #760: drawn on a 100 % canvas scaled to the Display size (viewBox), so
  // every coordinate, font and stroke below scales with it.
  const { factor: chartF } = useDisplayScale();
  const onLayout = (e: LayoutChangeEvent) => {
    setWidth(e.nativeEvent.layout.width / chartF);
    onWidth?.(e.nativeEvent.layout.width);
  };

  const { lo, hi } = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const v of values) {
      if (v === null) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    for (const b of bands) {
      if (b.from < min) min = b.from;
      if (b.to > max) max = b.to;
    }
    if (!Number.isFinite(min)) return { lo: 0, hi: 1 };
    if (max - min < 1e-6) return { lo: min - 1, hi: max + 1 };
    return { lo: min, hi: max };
  }, [values, bands]);

  const xFor = (d: number) =>
    totalM > 0 ? (Math.min(Math.max(d, 0), totalM) / totalM) * width : 0;
  const yFor = (v: number) => PAD_Y + (1 - (v - lo) / (hi - lo)) * (plotHeight - 2 * PAD_Y);

  const paths = useMemo(() => {
    if (width <= 0) return { line: '', fill: '' };
    let line = '';
    let fill = '';
    let run: { x: number; y: number }[] = [];
    const flush = () => {
      if (run.length >= 2) {
        const seg = run.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`);
        line += seg.join(' ') + ' ';
        if (area) {
          const first = run[0]!;
          const last = run[run.length - 1]!;
          fill += `${seg.join(' ')} L${last.x.toFixed(1)} ${plotHeight} L${first.x.toFixed(1)} ${plotHeight} Z `;
        }
      }
      run = [];
    };
    values.forEach((v, i) => {
      const d = distances[i];
      if (v === null || d === undefined) {
        flush();
        return;
      }
      run.push({ x: xFor(d), y: yFor(v) });
    });
    flush();
    return { line, fill };
    // xFor/yFor are pure functions of the listed inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, distances, width, lo, hi, area, plotHeight, totalM]);

  // Rebuilt when the handler or geometry changes: GestureDetector swaps the
  // callbacks into the SAME native handler, so a drag in progress carries on.
  const gestureId = `${testID ?? title}-scrub`;
  const scrub = useMemo(() => {
    // `x` is relative to the plot view the detector wraps, whatever SVG
    // element is under the finger.
    const at = ({ x }: { x: number }) => {
      const ratio = totalM > 0 ? scrubRatio(x / chartF, 0, width) : null;
      if (ratio !== null) onScrub(ratio * totalM);
    };
    return (
      Gesture.Pan()
        .runOnJS(true)
        .withTestId(gestureId)
        .activeOffsetX([-SCRUB_ACTIVATE_X, SCRUB_ACTIVATE_X])
        .failOffsetY([-SCRUB_FAIL_Y, SCRUB_FAIL_Y])
        // Touch-down places the cursor (a tap, or a press held still)...
        .onBegin(at)
        // ...and once the drag is a scrub (onStart: the activating frame),
        // it follows the finger.
        .onStart(at)
        .onUpdate(at)
    );
  }, [gestureId, width, totalM, onScrub, chartF]);

  const cx = cursorDistanceM !== null && width > 0 ? xFor(cursorDistanceM) : null;

  // Where each leader line meets the line: the value of the nearest sample.
  const valueNear = (d: number): number | null => {
    const n = distances.length;
    if (n === 0 || totalM <= 0) return null;
    const i = Math.min(n - 1, Math.max(0, Math.round((d / totalM) * (n - 1))));
    return values[i] ?? null;
  };

  // Stop labels: right of their line (left of it near the right edge), and a
  // row lower when they would overlap the label before (~5.6 px per glyph).
  const placed: { x0: number; x1: number; row: number }[] = [];
  const labelRows = marks.map((m) => {
    const x = xFor(m.distanceM);
    const right = x > width * 0.7;
    const w = m.label.length * 5.6;
    const x0 = right ? x - 4 - w : x + 4;
    const x1 = x0 + w;
    let row = 0;
    while (placed.some((p) => p.row === row && p.x0 < x1 + 4 && x0 < p.x1 + 4) && row < 3) row += 1;
    placed.push({ x0, x1, row });
    return { m, x, right, row };
  });

  return (
    <View style={[bare ? null : styles.card, { backgroundColor: t.surface }]} testID={testID}>
      {!bare && (
        <View style={styles.head}>
          <Text style={[styles.title, { color: t.ink }]}>{title}</Text>
          <Text
            style={[styles.value, { color: t.ink }]}
            testID={testID ? `${testID}-value` : undefined}
          >
            {valueText}
          </Text>
        </View>
      )}
      {above}
      <GestureDetector gesture={scrub}>
        <View
          style={{ height: plotHeight * chartF }}
          onLayout={onLayout}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={`${title} chart`}
          accessibilityValue={{ text: valueText }}
        >
          {width > 0 && (
            <Svg
              width={width * chartF}
              height={plotHeight * chartF}
              viewBox={`0 0 ${width} ${plotHeight}`}
            >
              {bands.map((b) => (
                <Rect
                  key={`b${b.from}`}
                  x={0}
                  y={yFor(b.to)}
                  width={width}
                  height={Math.max(0, yFor(b.from) - yFor(b.to))}
                  fill={b.color}
                  opacity={b.opacity}
                />
              ))}
              {guides.map((g, k) => {
                const v = valueNear(g.distanceM);
                const x = xFor(g.distanceM);
                return (
                  <Line
                    key={`g${k}`}
                    x1={g.fromX ?? x}
                    y1={0}
                    x2={x}
                    y2={v === null ? plotHeight : yFor(v)}
                    stroke={g.strong ? t.ink : t.outline}
                    strokeWidth={g.strong ? 1.5 : 0.75}
                    opacity={g.strong ? 0.9 : 0.6}
                  />
                );
              })}
              {area && paths.fill !== '' && <Path d={paths.fill} fill={color} opacity={0.18} />}
              {paths.line !== '' && (
                <Path d={paths.line} stroke={color} strokeWidth={2} fill="none" />
              )}
              {labelRows.map(({ m, x, right, row }) => (
                <Fragment key={`m${m.distanceM}`}>
                  <Line
                    x1={x}
                    y1={0}
                    x2={x}
                    y2={plotHeight}
                    stroke={t.outline}
                    strokeWidth={1}
                    strokeDasharray="3,3"
                  />
                  <SvgText
                    x={right ? x - 4 : x + 4}
                    y={11 + row * 12}
                    fontSize={10}
                    fill={t.inkMuted}
                    textAnchor={right ? 'end' : 'start'}
                  >
                    {m.label}
                  </SvgText>
                </Fragment>
              ))}
              {dots.map((d, k) => (
                <Circle
                  key={`d${k}`}
                  cx={xFor(d)}
                  cy={3}
                  r={2.5}
                  fill={t.inkVariant}
                  opacity={0.75}
                />
              ))}
              {cx !== null && (
                <Line x1={cx} y1={0} x2={cx} y2={plotHeight} stroke={t.ink} strokeWidth={2} />
              )}
            </Svg>
          )}
        </View>
      </GestureDetector>
      {footnote ? <Text style={[styles.foot, { color: t.inkMuted }]}>{footnote}</Text> : null}
    </View>
  );
}

const stylesSheet = StyleSheet.create({
  card: { borderRadius: 14, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 10, gap: 4 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  title: { fontSize: 13, fontWeight: '800' },
  value: { fontSize: 15, fontWeight: '800' },
  foot: { fontSize: 11.5 },
});
