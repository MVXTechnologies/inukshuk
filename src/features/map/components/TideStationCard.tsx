import { buildTideCard } from '@core/tides/card';
import { useSettingsStore } from '@state/settingsStore';
import type { TideStation } from '@core/tides/station';
import { tideColors } from '@core/map/tideStyle';
import { formatElevation } from '@core/format';
import {
  ageText,
  levelReading,
  predictedAt,
  rateText,
  tideGraph,
  type LevelReading,
  type TideGraphModel,
} from '@core/tides/levels';
import { useMemo, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Icon, IconButton, Surface, Text, useTheme } from '@ui/paper';
import { useTideSeries, type TideSeriesQuery } from '../hooks/useTideSeries';
import { useChsStationDetail } from '../hooks/useChs';
import { CONVERT_ENABLED } from '@core/features/flags';
import { convertFromTideStation, type ConvertRequest } from '@core/convert/entry';
import { tideImage } from '../tideImages';
import { tideClock, tzOffsetMs } from '../tideClock';
import { CopyValueButton } from './CopyValueButton';
import { TideGraph } from './TideGraph';
import { useScaledStyles, useDisplayScale } from '@ui/displayScale';

interface Props {
  station: TideStation | null;
  onOpenLink: (url: string) => void;
  onNavigate: () => void;
  /** Put a value on the clipboard and toast it. */
  onCopy: (text: string) => void;
  onClose: () => void;
  /** Open Convert on the station's chart datum (`@core/convert/entry`). */
  onConvert?: (req: ConvertRequest) => void;
  offline?: boolean;
  floating?: boolean;
}

const ARROW: Record<'up' | 'down' | 'flat', string> = {
  up: 'arrow-top-right',
  down: 'arrow-bottom-right',
  flat: 'arrow-right',
};

/** The tide now under the graph: the level, its trend, and when it was read. */
function ReadingRow({
  reading,
  series,
  now,
}: {
  reading: LevelReading;
  series: Parameters<typeof predictedAt>[0];
  now: number;
}) {
  const styles = useScaledStyles(stylesSheet);
  const { sz } = useDisplayScale();
  const theme = useTheme();
  const units = useSettingsStore((s) => s.units);
  const c = tideColors(theme.dark ? 'dark' : 'light');
  const muted = theme.colors.onSurfaceVariant;
  const h = (m: number) => formatElevation(m, units, { decimals: 2 });
  const predNow = predictedAt(series, now);
  return (
    <View style={styles.readingRow} testID="tide-now">
      <Text
        variant="titleLarge"
        style={[
          styles.readingValue,
          reading.kind === 'pred' && { color: c.label },
          reading.kind === 'stale' && styles.faded,
        ]}
      >
        {h(reading.heightM)}
      </Text>
      {reading.kind === 'stale' ? (
        <Text variant="bodyMedium" style={[styles.readingTrend, { color: muted }]}>
          {`at ${tideClock(reading.timeMs)} · ${ageText(reading.ageMs)} ago`}
        </Text>
      ) : (
        reading.dir !== null && (
          <View style={styles.trend}>
            <Icon source={ARROW[reading.dir]} size={sz(16)} color={c.station} />
            {reading.rateMPerH !== null && (
              <Text variant="bodyMedium" style={[styles.readingTrend, { color: c.station }]}>
                {rateText(reading.rateMPerH, units)}
              </Text>
            )}
          </View>
        )
      )}
      <View style={styles.flex} />
      <Text variant="bodySmall" style={{ color: muted }} numberOfLines={1}>
        {reading.kind === 'live'
          ? tideClock(reading.timeMs)
          : reading.kind === 'pred'
            ? 'predicted'
            : predNow !== null
              ? `now ≈ ${h(predNow)}`
              : ''}
      </Text>
    </View>
  );
}

/** The graph's key: solid observed, dashed predicted. */
function GraphKey({ observed }: { observed: boolean }) {
  const styles = useScaledStyles(stylesSheet);
  const theme = useTheme();
  const c = tideColors(theme.dark ? 'dark' : 'light');
  const muted = theme.colors.onSurfaceVariant;
  return (
    <View style={styles.key}>
      {observed && (
        <View style={styles.keyItem}>
          <View style={[styles.keySolid, { backgroundColor: c.station }]} />
          <Text variant="labelSmall" style={{ color: muted }}>
            observed
          </Text>
        </View>
      )}
      <View style={styles.keyItem}>
        <View style={styles.keyDashes}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={[styles.keyDash, { backgroundColor: c.station }]} />
          ))}
        </View>
        <Text variant="labelSmall" style={{ color: muted }}>
          predicted
        </Text>
      </View>
    </View>
  );
}

/**
 * The graph section, the card's first content (#764): the graph, the tide
 * now, the key; while loading or offline with nothing saved, one line.
 */
function GraphSection({ query, datum }: { query: TideSeriesQuery; datum: string }) {
  const styles = useScaledStyles(stylesSheet);
  const units = useSettingsStore((s) => s.units);
  const muted = useTheme().colors.onSurfaceVariant;
  // The clock the graph reads, fixed per series (a re-render never shifts it).
  const [now] = useState(() => Date.now());
  const series = query.status === 'ready' ? query.series : null;
  const graph: TideGraphModel | null = useMemo(
    () => (series ? tideGraph(series, now, units, tideClock, tzOffsetMs(now)) : null),
    [series, now, units],
  );
  const reading = useMemo(() => (series ? levelReading(series, now) : null), [series, now]);
  if (query.status === 'none') return null;
  if (query.status !== 'ready' || graph === null || series === null) {
    return (
      <Text
        variant="bodyMedium"
        style={[styles.section, { color: muted }]}
        testID="tide-graph-state"
      >
        {query.status === 'loading' ? 'Reading the tide…' : 'Needs a connection.'}
      </Text>
    );
  }
  return (
    <View style={styles.graphSection}>
      <TideGraph model={graph} datum={datum} />
      {reading !== null && <ReadingRow reading={reading} series={series} now={now} />}
      <GraphKey observed={graph.observed.length > 0} />
    </View>
  );
}

/**
 * A tapped tide station (Overlays → Tide stations): the tide graph first
 * (#764: observed past solid, predictions dashed, now, next high and low),
 * the tide now under it, then the agency's tidal levels in three datums
 * (chart datum · national datum · ellipsoid, owner Q4a), the position, the
 * chart-datum box with its sources and how far each number is checked, copy
 * buttons on every value, and the source credit (CHS: its licence notice).
 * A bottom card in the WaypointViewerCard idiom — never a Portal dialog (the
 * #108 soft-lock).
 */
export function TideStationCard({
  station,
  onOpenLink,
  onNavigate,
  onCopy,
  onClose,
  onConvert,
  offline = false,
  floating = false,
}: Props) {
  const { sz } = useDisplayScale();

  const styles = useScaledStyles(stylesSheet);

  const theme = useTheme();
  // A CHS station arrives as a map stub; its levels come live from CHS (cached).
  const chs = useChsStationDetail(station);
  const shown = chs.status === 'ready' ? chs.station : station;
  const model = useMemo(() => (shown ? buildTideCard(shown) : null), [shown]);
  const series = useTideSeries(station, offline);
  if (!station || !model) return null;
  const scheme = theme.dark ? 'dark' : 'light';
  const teal = tideColors(scheme).station;
  const muted = theme.colors.onSurfaceVariant;
  const icon = tideImage(scheme, station.kind === 'gauge');

  const position = (
    <View style={[styles.posRow, styles.section]}>
      <View style={styles.flex}>
        <Text variant="bodyMedium" selectable>
          {model.position.text}
        </Text>
        <Text variant="bodySmall" style={{ color: muted }}>
          {model.position.note}
        </Text>
      </View>
      <CopyValueButton
        text={model.position.copy}
        label={model.position.a11y}
        onCopy={onCopy}
        testID="tide-copy-position"
      />
    </View>
  );

  return (
    <Surface style={[styles.card, floating && styles.floating]} elevation={4} testID="tide-card">
      <View style={styles.header}>
        {icon !== undefined && <Image source={icon} style={styles.icon} />}
        <View style={styles.titles}>
          <Text variant="titleMedium" numberOfLines={1} accessibilityRole="header">
            {model.title}
          </Text>
          <Text variant="bodySmall" numberOfLines={1} style={{ color: muted }}>
            {model.subtitle}
          </Text>
        </View>
        <IconButton
          icon="close"
          size={20}
          onPress={onClose}
          accessibilityLabel="Close tide station"
        />
      </View>

      <ScrollView style={styles.body} nestedScrollEnabled>
        <GraphSection query={series} datum={model.cdLabel} />

        {chs.status === 'loading' && (
          <Text variant="bodyMedium" style={styles.section}>
            Reading CHS levels and datums…
          </Text>
        )}
        {chs.status === 'error' && (
          <Text variant="bodyMedium" style={styles.section}>
            CHS levels need a connection the first time (this station is not on the device yet).
          </Text>
        )}
        {chs.status === 'ready' && model.rows.length === 0 && (
          <Text variant="bodyMedium" style={styles.section}>
            CHS publishes no tidal levels for this station.
          </Text>
        )}
        {chs.status === 'ready' && chs.fromCache && (
          <Text variant="bodySmall" style={[styles.note, { color: muted }]}>
            Offline: CHS values saved on this device.
          </Text>
        )}

        {model.rows.length > 0 && (
          <View style={styles.section} testID="tide-levels">
            <View style={styles.tableTitle}>
              <Text variant="labelSmall" style={[styles.caps, styles.flex, { color: muted }]}>
                TIDAL LEVELS · METRES
              </Text>
              <Button
                compact
                mode="text"
                icon="table"
                onPress={() => onCopy(model.tableCopy)}
                accessibilityLabel="Copy the levels table"
                testID="tide-copy-table"
                labelStyle={styles.tableCopyLabel}
              >
                Copy table
              </Button>
            </View>
            <View style={[styles.tr, styles.th, { borderColor: theme.colors.outlineVariant }]}>
              <Text variant="labelSmall" style={[styles.codeCol, { color: muted }]}>
                LEVEL
              </Text>
              {model.columns.map((c) => (
                <View key={c.label} style={styles.numCol}>
                  <Text
                    variant="labelSmall"
                    style={[styles.right, { color: muted }]}
                    numberOfLines={1}
                  >
                    {c.label.toUpperCase()}
                  </Text>
                  {c.sub !== undefined && (
                    <Text style={[styles.right, styles.sub, { color: muted }]} numberOfLines={2}>
                      {c.sub}
                    </Text>
                  )}
                </View>
              ))}
              <View style={styles.copyCol} />
            </View>
            {model.rows.map((r) => (
              <View
                key={r.code}
                style={[styles.tr, { borderColor: theme.colors.outlineVariant }]}
                testID={`tide-row-${r.code}`}
              >
                <View style={styles.codeCol}>
                  <Text
                    variant="bodyMedium"
                    style={r.datum ? { color: teal, fontWeight: '700' } : undefined}
                    numberOfLines={1}
                  >
                    {r.code}
                  </Text>
                </View>
                {r.cells.map((c, i) => (
                  <Pressable
                    key={i}
                    style={styles.numCol}
                    disabled={c === null}
                    onPress={() => c && onCopy(c.copy)}
                    accessibilityRole="button"
                    accessibilityLabel={c?.a11y}
                  >
                    <Text
                      variant="bodyMedium"
                      style={[
                        styles.right,
                        styles.num,
                        r.datum ? { color: teal, fontWeight: '700' } : undefined,
                      ]}
                    >
                      {c?.text ?? '—'}
                    </Text>
                  </Pressable>
                ))}
                <View style={styles.copyCol}>
                  <CopyValueButton
                    text={r.copy}
                    label={`Copy ${r.code} in every datum`}
                    onCopy={onCopy}
                    size={sz(13)}
                  />
                </View>
              </View>
            ))}
            {model.extremes !== undefined && (
              <Text variant="bodySmall" style={[styles.note, { color: muted }]}>
                {model.extremes}
              </Text>
            )}
          </View>
        )}

        {position}

        {model.refPort !== undefined && (
          <View style={styles.section} testID="tide-ref-port">
            <Text variant="bodySmall" style={{ color: muted }}>
              {model.refPort.title}
            </Text>
            {model.refPort.rows.map((r) => (
              <View key={r.code} style={styles.refRow}>
                <Text variant="bodyMedium" style={styles.flex}>
                  {r.code}
                  {r.name !== undefined && (
                    <Text variant="bodySmall" style={{ color: muted }}>{`  ${r.name}`}</Text>
                  )}
                </Text>
                <Text variant="bodyMedium" style={styles.num}>
                  {r.cell.text}
                </Text>
                <CopyValueButton
                  text={r.cell.copy}
                  label={r.cell.a11y}
                  onCopy={onCopy}
                  size={sz(13)}
                />
              </View>
            ))}
          </View>
        )}

        {chs.status !== 'loading' && chs.status !== 'error' && (
          <View
            style={[styles.cdBox, { backgroundColor: theme.dark ? `${teal}1F` : `${teal}14` }]}
            testID="tide-cd-box"
          >
            <Text variant="bodyMedium" style={{ color: teal, fontWeight: '700' }}>
              {model.cdBox.title}
            </Text>
            {model.cdBox.values.map((v) => (
              <View key={v.copy} style={styles.refRow}>
                <Text variant="bodyMedium" style={styles.flex} selectable>
                  = {v.text}
                </Text>
                <CopyValueButton text={v.copy} label={v.a11y} onCopy={onCopy} size={sz(13)} />
              </View>
            ))}
            {model.cdBox.notes.map((n) => (
              <Text key={n} variant="bodySmall" style={{ color: muted }}>
                {n}
              </Text>
            ))}
          </View>
        )}
        {model.notice !== undefined && (
          <Text variant="labelSmall" style={[styles.note, { color: muted }]} testID="tide-notice">
            {model.notice}
          </Text>
        )}
      </ScrollView>

      <View style={styles.actions}>
        <Button
          mode="contained"
          icon="open-in-new"
          compact
          disabled={offline}
          onPress={() => onOpenLink(model.link.url)}
          accessibilityLabel={offline ? `${model.link.label} (needs connection)` : model.link.label}
          style={styles.grow}
        >
          {offline ? 'Needs connection' : model.link.label}
        </Button>
        <Button mode="outlined" icon="navigation-variant-outline" compact onPress={onNavigate}>
          Navigate
        </Button>
        {CONVERT_ENABLED && onConvert !== undefined && shown !== null && (
          <Button
            mode="outlined"
            icon="swap-vertical"
            compact
            onPress={() => onConvert(convertFromTideStation(shown))}
          >
            Convert
          </Button>
        )}
      </View>
      <Text variant="labelSmall" style={[styles.credit, { color: muted }]} numberOfLines={3}>
        {model.credit}
      </Text>
    </Surface>
  );
}

const stylesSheet = StyleSheet.create({
  card: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 8,
  },
  floating: { borderRadius: 16 },
  header: { flexDirection: 'row', alignItems: 'center' },
  icon: { width: 24, height: 24, marginRight: 10 },
  titles: { flex: 1 },
  body: { maxHeight: 360 },
  graphSection: { marginTop: 4 },
  readingRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 4 },
  readingValue: { fontWeight: '700', fontVariant: ['tabular-nums'] },
  readingTrend: { fontWeight: '600' },
  trend: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  faded: { opacity: 0.5 },
  key: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 2 },
  keyItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  keySolid: { width: 16, height: 2 },
  keyDashes: { flexDirection: 'row', gap: 2, width: 16 },
  keyDash: { width: 4, height: 1.5 },
  flex: { flex: 1 },
  posRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 2 },
  section: { marginTop: 8 },
  caps: { letterSpacing: 0.5 },
  tableTitle: { flexDirection: 'row', alignItems: 'center' },
  tableCopyLabel: { fontSize: 12, marginVertical: 2, marginHorizontal: 6 },
  tr: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    minHeight: 30,
  },
  th: { alignItems: 'flex-end', paddingBottom: 3 },
  codeCol: { width: 100 },
  numCol: { flex: 1, paddingLeft: 4, justifyContent: 'center', minHeight: 28 },
  copyCol: { width: 28, alignItems: 'flex-end' },
  right: { textAlign: 'right' },
  sub: { fontSize: 9, lineHeight: 11 },
  num: { fontVariant: ['tabular-nums'] },
  note: { marginTop: 4 },
  refRow: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 28 },
  cdBox: { borderRadius: 10, padding: 10, marginTop: 10, gap: 2 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  grow: { flexGrow: 1 },
  credit: { marginTop: 6, textAlign: 'center' },
});
