import type { AccuracyPanel as Panel, PanelLine } from '@core/convert/accuracy';
import { formatBytes, type Pack } from '@core/convert/packs';
import { palette, radius, space } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { StyleSheet, View } from 'react-native';
import { Button, Icon, ProgressBar, Text, useTheme } from 'react-native-paper';

interface Props {
  panel: Panel;
  /** Packs that would provide the missing grids (missing-grid refusal). */
  offer: Pack[];
  downloading: { id: string; done: number; total: number } | null;
  downloadError: string | null;
  onDownload: (pack: Pack) => void;
  /** Chart datum somewhere in the conversion: say "Not for navigation". */
  chart: boolean;
  /** Engine is lite (no PROJ in this build). */
  lite: boolean;
}

/**
 * The accuracy panel (mockups 08–09): the operations with their stated
 * accuracy, EPSG codes, epochs and grids, what they were validated against,
 * the input-precision warning, and the grid packs to download when one is
 * missing. Green / amber / red follow `@core/convert/accuracy`.
 */
export function AccuracyPanel({
  panel,
  offer,
  downloading,
  downloadError,
  onDownload,
  chart,
  lite,
}: Props) {
  const theme = useTheme();
  const tokens = useSchemeTokens();
  const okColor = theme.dark ? palette.sage : palette.sageDeep;
  const warnColor = tokens.status.pausedInk;
  const errColor = theme.colors.error;
  const iconOf = (l: PanelLine) =>
    l.icon === 'ok'
      ? { name: 'check-circle-outline', color: okColor }
      : l.icon === 'warn'
        ? { name: 'alert-outline', color: warnColor }
        : l.icon === 'error'
          ? { name: 'close-octagon-outline', color: errColor }
          : { name: 'information-outline', color: tokens.inkVariant };
  const headColor =
    panel.status === 'green' ? okColor : panel.status === 'amber' ? warnColor : errColor;

  return (
    <View
      style={[styles.panel, { backgroundColor: theme.colors.surfaceVariant }]}
      testID="convert-accuracy"
      accessibilityLabel={`Accuracy ${panel.status}: ${panel.headline}`}
    >
      <View style={styles.headRow}>
        <View style={[styles.dot, { backgroundColor: headColor }]} />
        <Text
          variant="labelLarge"
          style={{ color: tokens.ink }}
          testID={`convert-status-${panel.status}`}
        >
          {panel.status === 'red' ? 'Refused' : panel.headline}
        </Text>
      </View>
      {panel.lines.map((l, i) => {
        const ic = iconOf(l);
        return (
          <View key={i} style={styles.line}>
            <Icon source={ic.name} size={18} color={ic.color} />
            <Text variant="bodySmall" style={[styles.lineText, { color: tokens.ink }]}>
              {l.lead ? <Text style={styles.bold}>{`${l.lead} `}</Text> : null}
              {l.text}
            </Text>
          </View>
        );
      })}
      {lite && (
        <View style={styles.line}>
          <Icon source="information-outline" size={18} color={tokens.inkVariant} />
          <Text variant="bodySmall" style={[styles.lineText, { color: tokens.inkVariant }]}>
            This app version converts without grids only; datum and height conversions arrive with
            the next store update.
          </Text>
        </View>
      )}
      <View style={styles.chips}>
        {panel.grids.map((g) => (
          <View
            key={g.file}
            style={[
              styles.chip,
              { backgroundColor: g.available ? tokens.library.onMap : theme.colors.errorContainer },
            ]}
          >
            <Icon
              source={g.available ? 'check' : 'download-off-outline'}
              size={14}
              color={g.available ? tokens.library.onMapInk : theme.colors.onErrorContainer}
            />
            <Text
              variant="labelSmall"
              style={{
                color: g.available ? tokens.library.onMapInk : theme.colors.onErrorContainer,
              }}
            >
              {`${g.label}${g.bundled ? ' · built in' : g.available ? ' · on this device' : ''}`}
            </Text>
          </View>
        ))}
        {panel.credits.map((c) => (
          <View key={c} style={[styles.chip, styles.outlined, { borderColor: tokens.outline }]}>
            <Text variant="labelSmall" style={{ color: tokens.ink }}>
              {c}
            </Text>
          </View>
        ))}
        {chart && (
          <View style={[styles.chip, styles.outlined, { borderColor: tokens.outline }]}>
            <Text variant="labelSmall" style={{ color: tokens.ink }}>
              Not for navigation
            </Text>
          </View>
        )}
      </View>
      {offer.map((p) => {
        const busy = downloading?.id === p.id;
        return (
          <View key={p.id} style={styles.offer}>
            <Button
              mode="contained"
              icon="download"
              compact
              disabled={downloading !== null}
              loading={busy}
              onPress={() => onDownload(p)}
              accessibilityLabel={`Download ${p.name} grid pack`}
              testID={`convert-download-${p.id}`}
            >
              {`Download ${p.name} pack · ${formatBytes(p.bytes)}`}
            </Button>
            {busy && downloading && (
              <ProgressBar
                progress={downloading.total ? downloading.done / downloading.total : 0}
                style={styles.progress}
              />
            )}
          </View>
        );
      })}
      {downloadError && (
        <Text variant="bodySmall" style={{ color: errColor }}>
          {downloadError}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { borderRadius: radius.lg, padding: space.md, gap: space.xs },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: 2 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  line: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  lineText: { flex: 1 },
  bold: { fontWeight: '700' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginTop: space.xs },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: radius.md,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
  },
  outlined: { backgroundColor: 'transparent', borderWidth: 1 },
  offer: { marginTop: space.xs },
  progress: { marginTop: 4, borderRadius: 2 },
});
