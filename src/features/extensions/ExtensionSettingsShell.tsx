/**
 * Settings → Extensions: the frame every extension's entry shares.
 *
 * - not installed: its badge, name and what it is, "Get", its legend and a
 *   one-line note (cost, caveats);
 * - installed: its layer switch (also in Map overlays › Extensions), the
 *   extension's own rows (`children`: offline, coverage & sources…), then
 *   "Remove extension" behind a confirmation.
 */
import type { AnyExtensionKey } from '@core/extensions/keys';
import { extensionBasics } from '@core/extensions/registry';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import type { ReactNode } from 'react';
import { Alert, Image, StyleSheet, View, type ImageRequireSource } from 'react-native';
import { Button, Icon, List, Switch, Text, useTheme } from 'react-native-paper';

import { installExtension, removeExtension } from './actions';
import { setExtensionPrefs, useExtensionPrefs } from './prefs';

interface Props {
  extKey: AnyExtensionKey;
  badge: ImageRequireSource | undefined;
  /** A vector icon instead of the badge image (device extensions). */
  badgeIcon?: string;
  /** The badge symbol's side, px. */
  badgeIconSize: number;
  /** What it is, under its name before the install. */
  description: string;
  legend: ReactNode;
  /** The line under the legend before the install ("Free · …"). */
  note: string;
  /** The layer switch's accessibility label ("Show geodetic points"). */
  showLabel: string;
  /** The Remove row's second line. */
  removeDescription: string;
  /** The Remove confirmation's message. */
  removeMessage: string;
  /** Its own rows once installed, between the switch and Remove. */
  children?: ReactNode;
  /**
   * The switch row's second line (default: where the layer also lives, Map
   * overlays › Extensions). Device extensions say what their switch does.
   */
  switchDescription?: (on: boolean) => string;
}

const layerSwitchDescription = (on: boolean): string =>
  on ? 'On · Map overlays › Extensions' : 'Off · switch it on here or in Map overlays › Extensions';

export function ExtensionSettingsShell({
  extKey,
  badge,
  badgeIcon,
  badgeIconSize,
  description,
  legend,
  note,
  showLabel,
  removeDescription,
  removeMessage,
  children,
  switchDescription = layerSwitchDescription,
}: Props) {
  const tokens = useSchemeTokens();
  const theme = useTheme();
  const { installedAt, show } = useExtensionPrefs(extKey);
  const { label } = extensionBasics(extKey);
  const icon = { width: badgeIconSize, height: badgeIconSize };

  if (installedAt === 0) {
    return (
      <View style={styles.pad}>
        <View style={styles.getRow}>
          <View style={[styles.badge, { backgroundColor: tokens.surfaceVariant }]}>
            {badge !== undefined && <Image source={badge} style={icon} />}
            {badgeIcon !== undefined && (
              <Icon source={badgeIcon} size={badgeIconSize} color={tokens.ink} />
            )}
          </View>
          <View style={styles.flex}>
            <Text variant="titleSmall">{label}</Text>
            <Text variant="bodySmall" style={{ color: tokens.inkVariant }}>
              {description}
            </Text>
          </View>
          <Button
            mode="contained"
            compact
            icon="download"
            onPress={() => installExtension(extKey)}
            accessibilityLabel={`Get ${label}`}
          >
            Get
          </Button>
        </View>
        <View style={styles.legend}>{legend}</View>
        <Text variant="bodySmall" style={[styles.note, { color: tokens.inkMuted }]}>
          {note}
        </Text>
      </View>
    );
  }

  const confirmRemove = () =>
    Alert.alert(`Remove ${label}?`, removeMessage, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void removeExtension(extKey) },
    ]);

  return (
    <List.Section>
      <List.Item
        title={label}
        description={switchDescription(show)}
        left={() => (
          <View
            style={[styles.badge, styles.badgeInline, { backgroundColor: tokens.surfaceVariant }]}
          >
            {badge !== undefined && <Image source={badge} style={icon} />}
            {badgeIcon !== undefined && (
              <Icon source={badgeIcon} size={badgeIconSize} color={tokens.ink} />
            )}
          </View>
        )}
        right={() => (
          <Switch
            value={show}
            onValueChange={(v) => setExtensionPrefs(extKey, { show: v })}
            accessibilityLabel={showLabel}
          />
        )}
      />
      {children}
      <List.Item
        title="Remove extension"
        titleStyle={{ color: theme.colors.error }}
        description={removeDescription}
        onPress={confirmRemove}
        accessibilityLabel={`Remove ${label} extension`}
      />
    </List.Section>
  );
}

/** The rows' shared layout, for the extensions' own rows (coverage & sources…). */
export const extensionRowStyles = StyleSheet.create({
  pad: { paddingHorizontal: 16, paddingVertical: 8 },
  flex: { flex: 1 },
  note: { marginTop: 8 },
  sources: { paddingHorizontal: 16, paddingBottom: 8, gap: 2 },
  sourceRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 8 },
});

const styles = StyleSheet.create({
  ...extensionRowStyles,
  getRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  badge: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeInline: { marginLeft: 8 },
  legend: { marginTop: 10, marginLeft: 48 },
});
