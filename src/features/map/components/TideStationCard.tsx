import { buildTideCard, type TideChip } from '@core/tides/card';
import { nowLine } from '@core/tides/live';
import type { TideStation } from '@core/tides/station';
import { tideColors } from '@core/map/tideStyle';
import { useMemo } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Button, Icon, IconButton, Surface, Text, useTheme } from 'react-native-paper';
import { useLiveTide } from '../hooks/useLiveTide';
import { tideImage } from '../tideImages';
import { CopyValueButton } from './CopyValueButton';
import { useSchemeTokens } from '@ui/useSchemeTokens';

interface Props {
  station: TideStation | null;
  onOpenLink: (url: string) => void;
  onNavigate: () => void;
  /** Put a value on the clipboard and toast it. */
  onCopy: (text: string) => void;
  onClose: () => void;
  offline?: boolean;
  floating?: boolean;
}

/** "13:18 EDT": the phone's time, with its zone — the gauge may be in another one. */
function clock(ms: number): string {
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  try {
    const zone = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
      .formatToParts(d)
      .find((p) => p.type === 'timeZoneName')?.value;
    return zone ? `${hm} ${zone}` : hm;
  } catch {
    return hm;
  }
}

/**
 * A tapped tide station (Overlays → Tide stations; mockup 03): the live
 * level when online, the agency's tidal levels in three datums (chart datum ·
 * national datum · ellipsoid, owner Q4a), the chart-datum box with its
 * sources and how far each number is checked, copy buttons on every value,
 * and "Not for navigation". A bottom card in the WaypointViewerCard idiom —
 * never a Portal dialog (the #108 soft-lock).
 */
export function TideStationCard({
  station,
  onOpenLink,
  onNavigate,
  onCopy,
  onClose,
  offline = false,
  floating = false,
}: Props) {
  const theme = useTheme();
  const tokens = useSchemeTokens();
  const model = useMemo(() => (station ? buildTideCard(station) : null), [station]);
  const live = useLiveTide(station, offline);
  if (!station || !model) return null;
  const scheme = theme.dark ? 'dark' : 'light';
  const teal = tideColors(scheme).station;
  const muted = theme.colors.onSurfaceVariant;
  const icon = tideImage(scheme, station.kind === 'gauge');
  const line = live.status === 'ready' ? nowLine(live.live, model.cdLabel, clock) : null;

  const chipStyle = (tone: TideChip['tone']) => {
    switch (tone) {
      case 'station':
        return { bg: `${teal}26`, fg: teal };
      case 'live':
        return { bg: theme.colors.secondaryContainer, fg: theme.colors.onSecondaryContainer };
      case 'warn':
        return { bg: `${tokens.status.pausedInk}26`, fg: tokens.status.pausedInk };
      default:
        return { bg: theme.colors.surfaceVariant, fg: muted };
    }
  };

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

      <View style={styles.chips}>
        {model.chips.map((c) => {
          const s = chipStyle(c.tone);
          return (
            <View key={c.label} style={[styles.chip, { backgroundColor: s.bg }]}>
              {c.tone === 'warn' && <Icon source="alert-outline" size={13} color={s.fg} />}
              <Text variant="labelSmall" style={{ color: s.fg, fontWeight: '700' }}>
                {c.label}
              </Text>
            </View>
          );
        })}
      </View>

      <ScrollView style={styles.body} nestedScrollEnabled>
        <View style={styles.posRow}>
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

        {station.live !== undefined && (
          <View style={styles.section} testID="tide-now">
            <Text variant="labelSmall" style={[styles.caps, { color: muted }]}>
              NOW
            </Text>
            <Text variant="bodyMedium">
              {live.status === 'ready'
                ? (line ?? 'No recent reading from the gauge.')
                : live.status === 'loading'
                  ? 'Reading the gauge…'
                  : 'Live level needs a connection.'}
            </Text>
          </View>
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
                    size={13}
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
                <CopyValueButton text={r.cell.copy} label={r.cell.a11y} onCopy={onCopy} size={13} />
              </View>
            ))}
          </View>
        )}

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
              <CopyValueButton text={v.copy} label={v.a11y} onCopy={onCopy} size={13} />
            </View>
          ))}
          {model.cdBox.notes.map((n) => (
            <Text key={n} variant="bodySmall" style={{ color: muted }}>
              {n}
            </Text>
          ))}
        </View>
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
      </View>
      <Text variant="labelSmall" style={[styles.credit, { color: muted }]} numberOfLines={3}>
        {model.credit}
      </Text>
    </Surface>
  );
}

const styles = StyleSheet.create({
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
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2, marginBottom: 4 },
  chip: {
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  body: { maxHeight: 360 },
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
