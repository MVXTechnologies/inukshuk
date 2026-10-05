import type { CragRoute } from '@core/climbing/detail';
import { gradeChart, wallDiagram } from '@core/climbing/diagram';
import type { GradeSystem } from '@core/climbing/grades';
import { bandLabels } from '@core/climbing/grades';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useMemo, useState } from 'react';
import { type LayoutChangeEvent, ScrollView, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';
import Svg, { Circle, G, Line, Polygon, Rect, Text as SvgText } from 'react-native-svg';

import { useClimbingColors } from './ClimbingParts';

const HEIGHT = 250;

/**
 * The generated wall diagram (mockup 03): only ever for a sector whose
 * left-to-right order OSM gives. One line per route, height ∝ length, colour
 * = grade band, dashed = trad, dots = bolts, numbered as the list.
 */
export function WallDiagram({ title, routes }: { title: string; routes: readonly CragRoute[] }) {
  const t = useSchemeTokens();
  const c = useClimbingColors();
  const [width, setWidth] = useState(0);
  const d = useMemo(
    () => (width > 0 ? wallDiagram(routes, { width, height: HEIGHT }) : null),
    [routes, width],
  );
  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width));
  const ink = (band: number | null) => (band === null ? c.none : (c.bands[band] ?? c.none));
  const svg = d && (
    <Svg width={d.width} height={d.height} accessibilityLabel={`Wall diagram of ${title}`}>
      <Polygon points={d.ridge.map(([x, y]) => `${x},${y}`).join(' ')} fill={t.surfaceVariant} />
      <Rect x={0} y={d.baseY} width={d.width} height={d.height - d.baseY} fill={t.surface} />
      <Line x1={0} y1={d.baseY} x2={d.width} y2={d.baseY} stroke={t.outline} strokeWidth={1} />
      {d.lines.map((l) => (
        <G key={l.n}>
          <Line
            x1={l.x}
            y1={d.baseY}
            x2={l.x}
            y2={l.topY}
            stroke={ink(l.band)}
            strokeWidth={3}
            strokeDasharray={l.dashed ? '6 4' : undefined}
            strokeLinecap="round"
          />
          {l.bolts.map((y, i) => (
            <Circle
              key={i}
              cx={l.x}
              cy={y}
              r={2.6}
              fill={t.surface}
              stroke={ink(l.band)}
              strokeWidth={1.4}
            />
          ))}
          <Circle
            cx={l.x}
            cy={l.topY}
            r={3.2}
            fill={t.surface}
            stroke={ink(l.band)}
            strokeWidth={1.6}
          />
          <Circle cx={l.x} cy={d.baseY + 16} r={11} fill={ink(l.band)} />
          <SvgText
            x={l.x}
            y={d.baseY + 20}
            fontSize={11}
            fontWeight="bold"
            fill={c.bandInk}
            textAnchor="middle"
          >
            {String(l.n)}
          </SvgText>
        </G>
      ))}
    </Svg>
  );
  return (
    <View
      style={[styles.frame, { backgroundColor: t.surfaceVariant }]}
      onLayout={onLayout}
      testID="crag-wall-diagram"
    >
      <View style={styles.caption}>
        <Text style={[styles.captionText, { color: t.inkVariant }]} numberOfLines={1}>
          {`${title} · left → right`}
        </Text>
        <Text style={[styles.captionText, { color: t.inkMuted }]}>Generated · not to scale</Text>
      </View>
      {d !== null &&
        (d.scrolls ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {svg}
          </ScrollView>
        ) : (
          svg
        ))}
    </View>
  );
}

/** The grade chart (mockup 03b) for a sector whose wall order is unknown. */
export function GradeChartView({
  title,
  routes,
  system,
}: {
  title: string;
  routes: readonly CragRoute[];
  system: GradeSystem;
}) {
  const t = useSchemeTokens();
  const c = useClimbingColors();
  const [width, setWidth] = useState(0);
  const chart = useMemo(() => gradeChart(routes, system), [routes, system]);
  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width));
  const bins = chart?.bins ?? [];
  const max = Math.max(1, ...bins.map((b) => b.count));
  const plotH = 140;
  const gap = 8;
  const barW =
    bins.length > 0 ? Math.min(44, (width - 24 - gap * (bins.length - 1)) / bins.length) : 0;
  return (
    <View
      style={[styles.frame, { backgroundColor: t.surfaceVariant }]}
      onLayout={onLayout}
      testID="crag-grade-chart"
    >
      <View style={styles.caption}>
        <Text style={[styles.captionText, { color: t.inkVariant }]} numberOfLines={1}>
          {`${title} · by grade`}
        </Text>
        <Text style={[styles.captionText, { color: t.inkMuted }]}>Wall order unknown</Text>
      </View>
      {width > 0 && bins.length > 0 && (
        <Svg width={width} height={plotH + 40} accessibilityLabel={`Routes by grade in ${title}`}>
          {bins.map((b, i) => {
            const h = (b.count / max) * plotH;
            const x = 12 + i * (barW + gap);
            return (
              <G key={b.label}>
                <Rect
                  x={x}
                  y={plotH - h + 14}
                  width={barW}
                  height={h}
                  rx={3}
                  fill={c.bands[b.band]}
                />
                <SvgText
                  x={x + barW / 2}
                  y={plotH - h + 10}
                  fontSize={11}
                  fontWeight="bold"
                  fill={t.ink}
                  textAnchor="middle"
                >
                  {String(b.count)}
                </SvgText>
                <SvgText
                  x={x + barW / 2}
                  y={plotH + 30}
                  fontSize={11}
                  fill={t.inkVariant}
                  textAnchor="middle"
                >
                  {b.label}
                </SvgText>
              </G>
            );
          })}
        </Svg>
      )}
      {bins.length === 0 && (
        <Text style={[styles.note, { color: t.inkMuted }]}>
          No grades in the open data for this sector.
        </Text>
      )}
      <Text style={[styles.note, { color: t.inkVariant }]}>
        Help us draw this wall: add the route starts in OpenStreetMap, or attach your own topo.
      </Text>
    </View>
  );
}

/** The legend under the diagram: the bands, trad, bolted. */
export function DiagramLegend({ system, diagram }: { system: GradeSystem; diagram: boolean }) {
  const t = useSchemeTokens();
  const c = useClimbingColors();
  const labels = bandLabels(system);
  return (
    <View style={styles.legend}>
      {labels.map((label, i) => (
        <View key={label} style={styles.legendItem}>
          <View style={[styles.swatch, { backgroundColor: c.bands[i] }]} />
          <Text style={[styles.legendText, { color: t.inkVariant }]}>{label}</Text>
        </View>
      ))}
      {diagram && (
        <>
          <Text style={[styles.legendText, { color: t.inkVariant }]}>╌ trad</Text>
          <Text style={[styles.legendText, { color: t.inkVariant }]}>○ bolted</Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { borderRadius: 16, overflow: 'hidden', paddingBottom: 8 },
  caption: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: 10,
    gap: 8,
  },
  captionText: { fontSize: 13, lineHeight: 17, fontWeight: '600', flexShrink: 1 },
  note: { fontSize: 13, lineHeight: 18, paddingHorizontal: 12 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 4 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  swatch: { width: 10, height: 10, borderRadius: 2 },
  legendText: { fontSize: 13, lineHeight: 17 },
});
