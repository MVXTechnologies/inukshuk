import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  PanResponder,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from 'react-native';
import { Text } from 'react-native-paper';
import Svg, { Line, Path, Rect, Text as SvgText } from 'react-native-svg';

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
}

const PAD_Y = 6;

/**
 * One chart of the trail view (#511, board C2): a line over the trail's
 * distance with a shared cursor. Touch and drag anywhere on it to move the
 * cursor — the screen moves every chart's cursor, the map marker and the
 * readout with it. A drag that is mostly vertical is handed to the page
 * scroll instead, so the tab still scrolls over its charts.
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
}: Props) {
  const t = useSchemeTokens();
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

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

  // Latest scrub handler and geometry, read by the long-lived responder.
  const latest = useRef({ width, totalM, onScrub });
  useEffect(() => {
    latest.current = { width, totalM, onScrub };
  }, [width, totalM, onScrub]);
  const pan = useMemo(() => {
    const at = (e: GestureResponderEvent) => {
      const { width: w, totalM: tm, onScrub: cb } = latest.current;
      if (w <= 0 || tm <= 0) return;
      const ratio = Math.min(1, Math.max(0, e.nativeEvent.locationX / w));
      cb(ratio * tm);
    };
    // The ref is read on touch events only, never during render.
    // eslint-disable-next-line react-hooks/refs
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // A mostly vertical drag is the page scrolling (the Charts tab can be
      // taller than the screen): hand it over. Sideways drags keep scrubbing.
      onPanResponderTerminationRequest: (_e, g) => Math.abs(g.dy) > 2 * Math.abs(g.dx),
      onShouldBlockNativeResponder: () => false,
      onPanResponderGrant: at,
      onPanResponderMove: at,
    });
  }, []);

  const cx = cursorDistanceM !== null && width > 0 ? xFor(cursorDistanceM) : null;

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
    <View style={[styles.card, { backgroundColor: t.surface }]} testID={testID}>
      <View style={styles.head}>
        <Text style={[styles.title, { color: t.ink }]}>{title}</Text>
        <Text
          style={[styles.value, { color: t.ink }]}
          testID={testID ? `${testID}-value` : undefined}
        >
          {valueText}
        </Text>
      </View>
      <View
        style={{ height: plotHeight }}
        onLayout={onLayout}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={`${title} chart`}
        accessibilityValue={{ text: valueText }}
        {...pan.panHandlers}
      >
        {width > 0 && (
          <Svg width={width} height={plotHeight}>
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
            {cx !== null && (
              <Line x1={cx} y1={0} x2={cx} y2={plotHeight} stroke={t.ink} strokeWidth={2} />
            )}
          </Svg>
        )}
      </View>
      {footnote ? <Text style={[styles.foot, { color: t.inkMuted }]}>{footnote}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 14, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 10, gap: 4 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  title: { fontSize: 13, fontWeight: '800' },
  value: { fontSize: 15, fontWeight: '800' },
  foot: { fontSize: 11.5 },
});
