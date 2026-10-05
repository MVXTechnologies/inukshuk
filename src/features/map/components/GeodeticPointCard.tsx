import { buildGeodeticCard, type CardChip } from '@core/geodetic/card';
import type { GeodeticMark } from '@core/geodetic/record';
import { geodeticColors } from '@core/map/geodeticStyle';
import { useEffect, useMemo, useState } from 'react';
import { Image, ScrollView, StyleSheet, View } from 'react-native';
import { Button, IconButton, Surface, Text, useTheme } from 'react-native-paper';
import { geodeticImage } from '../geodeticImages';

interface Props {
  mark: GeodeticMark | null;
  /** Open the agency datasheet (or its page) — the system browser. */
  onOpenLink: (url: string) => void;
  onNavigate: () => void;
  /** Copy `text`; `what` names it for the confirmation ("UTM zone 19N", "all values"). */
  onCopy: (text: string, what: string) => void;
  onClose: () => void;
  /** No network: the datasheet can't open. */
  offline?: boolean;
  floating?: boolean;
}

/**
 * The tapped survey mark, at a glance (Settings → Extensions → Geodetic
 * points): the agency's own published coordinates and heights, verbatim and
 * labelled with their datums (`@core/geodetic/card`), the monument in the
 * agency's words, and a way out to the full datasheet. A bottom card in the
 * WaypointViewerCard idiom — never a Portal dialog (the #108 soft-lock).
 */
export function GeodeticPointCard({
  mark,
  onOpenLink,
  onNavigate,
  onCopy,
  onClose,
  offline = false,
  floating = false,
}: Props) {
  const theme = useTheme();
  const model = useMemo(() => (mark ? buildGeodeticCard(mark) : null), [mark]);
  // The line whose copy button shows a check (briefly, after a copy).
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (copied === null) return;
    const t = setTimeout(() => setCopied(null), 1400);
    return () => clearTimeout(t);
  }, [copied]);
  if (!mark || !model) return null;
  const scheme = theme.dark ? 'dark' : 'light';
  const colors = geodeticColors(scheme);
  const muted = theme.colors.onSurfaceVariant;
  const icon = mark.tidal
    ? geodeticImage(scheme, 'tbm')
    : geodeticImage(scheme, mark.type, mark.legacy);
  const typeColor = colors[mark.type];

  const chipStyle = (tone: CardChip['tone']) => {
    switch (tone) {
      case 'type':
        return { bg: `${typeColor}22`, fg: typeColor };
      case 'ok':
        return { bg: theme.colors.secondaryContainer, fg: theme.colors.onSecondaryContainer };
      case 'warn':
        return { bg: theme.colors.errorContainer, fg: theme.colors.onErrorContainer };
      case 'tidal':
        return { bg: `${colors['3d']}26`, fg: colors['3d'] };
      default:
        return { bg: theme.colors.surfaceVariant, fg: muted };
    }
  };

  return (
    <Surface
      style={[styles.card, floating && styles.floating]}
      elevation={4}
      testID="geodetic-card"
    >
      <View style={styles.header}>
        {icon !== undefined && <Image source={icon} style={styles.icon} />}
        <View style={styles.titles}>
          <Text variant="titleMedium" numberOfLines={1} selectable accessibilityRole="header">
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
          accessibilityLabel="Close survey mark"
        />
      </View>

      <View style={styles.chips}>
        {model.chips.map((c) => {
          const s = chipStyle(c.tone);
          return (
            <View key={c.label} style={[styles.chip, { backgroundColor: s.bg }]}>
              <Text variant="labelSmall" style={{ color: s.fg, fontWeight: '700' }}>
                {c.label}
              </Text>
            </View>
          );
        })}
      </View>

      <ScrollView style={styles.rows} nestedScrollEnabled>
        {model.rows.map((row) => (
          <View key={row.key} style={styles.row} testID={`geodetic-row-${row.key}`}>
            <Text variant="labelSmall" style={[styles.label, { color: muted }]}>
              {row.label.toUpperCase()}
            </Text>
            <View style={styles.values}>
              {row.lines.map((line, i) => {
                const key = `${row.key}-${i}`;
                const text = (
                  <Text
                    variant={line.muted ? 'bodySmall' : 'bodyMedium'}
                    style={[line.muted ? { color: muted } : undefined, styles.lineText]}
                    selectable
                  >
                    {line.text}
                    {line.note !== undefined && (
                      <Text variant="bodySmall" style={{ color: muted }}>
                        {`  ${line.note}`}
                      </Text>
                    )}
                  </Text>
                );
                if (line.copy === undefined) return <View key={key}>{text}</View>;
                const copyText = line.copy;
                const done = copied === key;
                return (
                  <View key={key} style={styles.lineRow}>
                    {text}
                    <IconButton
                      icon={done ? 'check' : 'content-copy'}
                      size={14}
                      iconColor={done ? theme.colors.primary : muted}
                      onPress={() => {
                        onCopy(copyText, line.copyName ?? 'value');
                        setCopied(key);
                      }}
                      accessibilityLabel={`Copy ${line.copyName ?? 'value'}`}
                      accessibilityHint={copyText}
                      style={styles.lineCopy}
                    />
                  </View>
                );
              })}
            </View>
          </View>
        ))}
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
        <IconButton
          icon="content-copy"
          mode="outlined"
          size={18}
          onPress={() => onCopy(model.copyText, 'all published values')}
          accessibilityLabel="Copy published values"
          style={styles.tight}
        />
      </View>
      {model.credit !== '' && (
        <Text variant="labelSmall" style={[styles.credit, { color: muted }]} numberOfLines={2}>
          {model.credit}
        </Text>
      )}
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
  icon: { width: 18, height: 18, marginRight: 10 },
  titles: { flex: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2, marginBottom: 6 },
  chip: { borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  rows: { maxHeight: 260 },
  row: { flexDirection: 'row', paddingVertical: 3 },
  label: { width: 84, paddingTop: 2, letterSpacing: 0.4 },
  values: { flex: 1 },
  lineRow: { flexDirection: 'row', alignItems: 'flex-start' },
  lineText: { flex: 1 },
  lineCopy: { margin: 0, marginTop: -6, marginRight: -8, width: 28, height: 28 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  grow: { flexGrow: 1 },
  tight: { margin: 0 },
  credit: { marginTop: 6, textAlign: 'center' },
});
