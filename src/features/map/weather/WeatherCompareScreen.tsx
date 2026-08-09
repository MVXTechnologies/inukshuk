import { ECCC_ATTRIBUTION, weatherLayerById, type WeatherLayerId } from '@core/geo/weatherLayers';
import { daySegments } from '@core/geo/weatherTimeline';
import type { LatLng } from '@core/models';
import { compareCellKey } from '@core/weather/modelTimeline';
import {
  compareCellText,
  compareUnitLabel,
  modelVariableForLayer,
  WEATHER_MODELS,
  type ModelVariable,
  type WeatherModel,
} from '@core/weather/weatherModels';
import { useSettingsStore } from '@state/settingsStore';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Animated, ScrollView, StyleSheet, View } from 'react-native';
import { IconButton, Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCompareMatrix } from './useCompareMatrix';
import { weatherChrome as wc } from './weatherChrome';

/**
 * Model-comparison table (weather UX M2, the Windy "Compare forecasts"
 * idiom): a full-screen fixed-dark surface stacking one meteogram card per
 * ECCC model — HRDPS / RDPS / GDPS — each showing the next 48 h as
 * day-grouped 3-hourly columns of the active layer's variable plus
 * temperature at the long-pressed (or map-centre) point, with the model's
 * run age in the card header.
 *
 * Data is one GetFeatureInfo request per cell (see useCompareMatrix for the
 * pacing/caching story). Degradation is Windy-quiet: pending cells shimmer,
 * failed cells settle to "–" silently, and only a fully-failed table admits
 * "needs a connection". Fixed dark chrome in both themes, like every other
 * weather surface (weatherChrome.ts).
 */
export function WeatherCompareScreen({ at, layer }: { at: LatLng; layer: WeatherLayerId | null }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const units = useSettingsStore((s) => s.units);
  const imperial = units === 'imperial';

  const variable: ModelVariable = (layer !== null ? modelVariableForLayer(layer) : null) ?? 'temp';
  const matrix = useCompareMatrix(at, variable);

  // Skeleton shimmer: one shared pulse for every pending cell. Lazy useState
  // (not a ref) — the value is read during render, which react-hooks/refs
  // forbids for refs.
  const [shimmer] = useState(() => new Animated.Value(0.35));
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(shimmer, { toValue: 0.75, duration: 650, useNativeDriver: true }),
        Animated.timing(shimmer, { toValue: 0.35, duration: 650, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [shimmer]);

  const times = matrix.timesMs;
  const segments = useMemo(() => (times !== null ? daySegments(times) : []), [times]);

  const variableLabel =
    layer !== null && modelVariableForLayer(layer) !== null
      ? weatherLayerById(layer).label
      : 'Temperature';

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <IconButton
          icon="arrow-left"
          size={22}
          iconColor={wc.ink}
          onPress={() => router.back()}
          accessibilityLabel="Close comparison"
          style={styles.backButton}
        />
        <View style={styles.headerText}>
          <Text style={styles.title}>Model comparison</Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {variableLabel}
            {variable !== 'temp' ? ' + temperature' : ''} · {at.latitude.toFixed(2)}°,{' '}
            {at.longitude.toFixed(2)}°
          </Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 20 }]}
        showsVerticalScrollIndicator={false}
      >
        {matrix.allFailed && (
          <Text style={styles.offlineNote}>Values unavailable — needs a connection.</Text>
        )}
        {WEATHER_MODELS.map((model) => (
          <ModelCard
            key={model.id}
            model={model}
            variable={variable}
            imperial={imperial}
            at={at}
            times={times}
            segments={segments}
            cells={matrix.cells}
            runLabel={matrix.runLabels[model.id] ?? null}
            shimmer={shimmer}
          />
        ))}
        <Text style={styles.attribution}>{ECCC_ATTRIBUTION}</Text>
      </ScrollView>
    </View>
  );
}

function ModelCard({
  model,
  variable,
  imperial,
  at,
  times,
  segments,
  cells,
  runLabel,
  shimmer,
}: {
  model: WeatherModel;
  variable: ModelVariable;
  imperial: boolean;
  at: LatLng;
  times: readonly number[] | null;
  segments: ReturnType<typeof daySegments>;
  cells: ReadonlyMap<string, number | null>;
  runLabel: string | null;
  shimmer: Animated.Value;
}) {
  // Row order: the active variable first, temperature beneath (Windy's
  // stacked-card row order); a temp layer shows the single temp row.
  const rows: { infoLayer: string; unit: string; rowVariable: ModelVariable }[] =
    variable === 'temp'
      ? [
          {
            infoLayer: model.info.temp,
            unit: compareUnitLabel('temp', imperial),
            rowVariable: 'temp',
          },
        ]
      : [
          {
            infoLayer: model.info[variable],
            unit: compareUnitLabel(variable, imperial),
            rowVariable: variable,
          },
          {
            infoLayer: model.info.temp,
            unit: compareUnitLabel('temp', imperial),
            rowVariable: 'temp',
          },
        ];

  const cell = (infoLayer: string, rowVariable: ModelVariable, t: number) => {
    const value = cells.get(compareCellKey(infoLayer, t, at.latitude, at.longitude));
    if (value === undefined) {
      return <Animated.View style={[styles.skeleton, { opacity: shimmer }]} />;
    }
    if (value === null) return <Text style={styles.cellMuted}>–</Text>;
    return <Text style={styles.cellText}>{compareCellText(rowVariable, value, imperial)}</Text>;
  };

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.modelName}>{model.label}</Text>
        <Text style={styles.modelRes}>{model.resolution}</Text>
        <View style={styles.headerSpacer} />
        {runLabel !== null && <Text style={styles.runAge}>{runLabel}</Text>}
      </View>
      <View style={styles.grid}>
        {/* Fixed left rail: spacer matching the day+hour label stack, then
            one unit label per value row (same CELL_H rhythm as the cells). */}
        <View style={styles.rail}>
          <View style={styles.railLabelSpacer} />
          {rows.map((r, i) => (
            <Text key={`${r.infoLayer}-${i}`} style={styles.railUnit}>
              {r.unit}
            </Text>
          ))}
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={styles.columns}>
            {segments.map((seg) => (
              <View key={seg.startIdx} style={styles.dayGroup}>
                <Text style={styles.dayLabel} numberOfLines={1}>
                  {times !== null
                    ? `${seg.label.toUpperCase()} ${new Date(times[seg.startIdx] ?? 0).getDate()}`
                    : ''}
                </Text>
                <View style={styles.dayColumns}>
                  {times !== null &&
                    times.slice(seg.startIdx, seg.endIdx + 1).map((t) => (
                      <View key={t} style={styles.column}>
                        <Text style={styles.hourLabel}>
                          {String(new Date(t).getHours()).padStart(2, '0')}
                        </Text>
                        {rows.map((r, i) => (
                          <View key={`${r.infoLayer}-${i}`} style={styles.cell}>
                            {cell(r.infoLayer, r.rowVariable, t)}
                          </View>
                        ))}
                      </View>
                    ))}
                </View>
              </View>
            ))}
          </View>
        </ScrollView>
      </View>
    </View>
  );
}

const CELL_W = 42;
const CELL_H = 26;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#101418' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 6 },
  backButton: { margin: 0 },
  headerText: { flex: 1, marginLeft: 2 },
  title: { fontSize: 19, lineHeight: 24, fontWeight: '700', color: wc.ink },
  subtitle: { fontSize: 12, lineHeight: 16, color: wc.inkMuted, marginTop: 1 },
  body: { paddingHorizontal: 12, paddingTop: 6, gap: 12 },
  offlineNote: { fontSize: 12, lineHeight: 16, color: wc.inkMuted, marginLeft: 4 },
  card: {
    backgroundColor: wc.panelSolid,
    borderRadius: 18,
    paddingVertical: 12,
    paddingHorizontal: 12,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginBottom: 10 },
  modelName: { fontSize: 15, lineHeight: 19, fontWeight: '700', color: wc.ink },
  modelRes: { fontSize: 12, lineHeight: 16, color: wc.inkFaint },
  headerSpacer: { flex: 1 },
  runAge: { fontSize: 12, lineHeight: 16, color: wc.inkMuted, fontVariant: ['tabular-nums'] },
  grid: { flexDirection: 'row' },
  rail: { marginRight: 8 },
  // dayLabel (12 + 5 margin) + hourLabel (14 + 3 margin) above the cells.
  railLabelSpacer: { height: 34 },
  railUnit: { fontSize: 12, lineHeight: CELL_H, color: wc.inkFaint, height: CELL_H },
  columns: { flexDirection: 'row', gap: 10 },
  dayGroup: {},
  dayLabel: {
    fontSize: 9,
    lineHeight: 12,
    letterSpacing: 0.8,
    color: wc.inkMuted,
    marginBottom: 5,
    marginLeft: 2,
  },
  dayColumns: { flexDirection: 'row' },
  column: { width: CELL_W, alignItems: 'center' },
  hourLabel: {
    fontSize: 11,
    lineHeight: 14,
    color: wc.inkMuted,
    fontVariant: ['tabular-nums'],
    marginBottom: 3,
  },
  cell: { height: CELL_H, alignItems: 'center', justifyContent: 'center' },
  cellText: {
    fontSize: 13,
    lineHeight: 17,
    color: wc.ink,
    fontVariant: ['tabular-nums'],
  },
  cellMuted: { fontSize: 13, lineHeight: 17, color: wc.inkFaint },
  skeleton: {
    width: CELL_W - 14,
    height: 12,
    borderRadius: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.16)',
  },
  attribution: { fontSize: 10, lineHeight: 14, color: wc.inkFaint, marginTop: 4, marginLeft: 4 },
});
