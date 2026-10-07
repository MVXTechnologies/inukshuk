/**
 * Settings → Extensions: the frame every extension's entry shares.
 *
 * Collapsed (the default), one settings-row high: its badge, name (and a
 * short status when there is one), its one-line `summary` and, on the right,
 * its primary control: "Get" before the install, its on/off switch after.
 * Tapping the row (or its chevron) expands the details inline
 * (`./expansion`: one entry open at a time):
 *
 * - not installed: what it is, its legend and a one-line note (cost, caveats);
 * - installed: what it is, its legend, the extension's own rows (`children`:
 *   offline, coverage & sources…), then "Remove extension" behind a
 *   confirmation.
 *
 * The row and the control are separate accessibility elements: the row is a
 * button with its expanded state, the Get button or switch is reachable
 * without expanding, and the details follow them in reading order.
 */
import type { AnyExtensionKey } from '@core/extensions/keys';
import { extensionBasics } from '@core/extensions/registry';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import type { ReactNode } from 'react';
import { Alert, Image, StyleSheet, View, type ImageRequireSource } from 'react-native';
import { Button, Icon, List, Switch, Text, TouchableRipple, useTheme } from 'react-native-paper';

import { installExtension, removeExtension } from './actions';
import { useExtensionExpanded } from './expansion';
import { setExtensionPrefs, useExtensionPrefs } from './prefs';

interface Props {
  extKey: AnyExtensionKey;
  badge: ImageRequireSource | undefined;
  /** A vector icon instead of the badge image (device extensions). */
  badgeIcon?: string;
  /** The badge symbol's side, px. */
  badgeIconSize: number;
  /** What it is, first in its details. */
  description: string;
  legend: ReactNode;
  /** The details' last line before the install ("Free · …"). */
  note: string;
  /**
   * A few words after its name in the collapsed row, once installed, when
   * there is something to say ("Offline ✓", "Update available"). Keep it
   * short: the name gives way first, and long ones are cut.
   */
  status?: string;
  /**
   * The line under the description once installed: what the switch does
   * (default: where the layer's switch also lives, Map overlays ›
   * Extensions). Device extensions say what their switch does.
   */
  switchDescription?: (on: boolean) => string;
  /** The layer switch's accessibility label ("Show geodetic points"). */
  showLabel: string;
  /** The Remove row's second line. */
  removeDescription: string;
  /** The Remove confirmation's message. */
  removeMessage: string;
  /** Its own rows once installed, between the description and Remove. */
  children?: ReactNode;
}

const layerSwitchDescription = (): string => 'Also on and off in Map overlays › Extensions';

export function ExtensionSettingsShell({
  extKey,
  badge,
  badgeIcon,
  badgeIconSize,
  description,
  legend,
  note,
  status,
  switchDescription = layerSwitchDescription,
  showLabel,
  removeDescription,
  removeMessage,
  children,
}: Props) {
  const tokens = useSchemeTokens();
  const theme = useTheme();
  const { installedAt, show } = useExtensionPrefs(extKey);
  const { label, summary } = extensionBasics(extKey);
  const [expanded, toggle] = useExtensionExpanded(extKey);
  const installed = installedAt !== 0;
  const shownStatus = installed ? status : undefined;

  const confirmRemove = () =>
    Alert.alert(`Remove ${label}?`, removeMessage, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void removeExtension(extKey) },
    ]);

  return (
    <View>
      <View style={styles.row}>
        <TouchableRipple
          onPress={toggle}
          style={styles.rowTouch}
          accessibilityRole="button"
          accessibilityLabel={[label, shownStatus, summary].filter(Boolean).join(', ')}
          accessibilityHint={expanded ? 'Hides the details' : 'Shows the details'}
          accessibilityState={{ expanded }}
          testID={`extension-row-${extKey}`}
        >
          <View style={styles.rowInner}>
            <View style={[styles.badge, { backgroundColor: tokens.surfaceVariant }]}>
              {badge !== undefined && (
                <Image source={badge} style={{ width: badgeIconSize, height: badgeIconSize }} />
              )}
              {badgeIcon !== undefined && (
                <Icon source={badgeIcon} size={badgeIconSize} color={tokens.ink} />
              )}
            </View>
            <View style={styles.text}>
              <View style={styles.titleLine}>
                <Text
                  variant="bodyLarge"
                  numberOfLines={1}
                  style={[styles.title, { color: tokens.ink }]}
                >
                  {label}
                </Text>
                {shownStatus !== undefined && (
                  <Text
                    variant="labelSmall"
                    numberOfLines={1}
                    style={[styles.status, { color: tokens.inkMuted }]}
                  >
                    {shownStatus}
                  </Text>
                )}
              </View>
              <Text variant="bodyMedium" numberOfLines={1} style={{ color: tokens.inkVariant }}>
                {summary}
              </Text>
            </View>
            <Icon
              source={expanded ? 'chevron-up' : 'chevron-down'}
              size={20}
              color={tokens.inkMuted}
            />
          </View>
        </TouchableRipple>
        <View style={styles.control}>
          {installed ? (
            <Switch
              value={show}
              onValueChange={(v) => setExtensionPrefs(extKey, { show: v })}
              accessibilityLabel={showLabel}
            />
          ) : (
            <Button
              mode="contained-tonal"
              compact
              onPress={() => installExtension(extKey)}
              accessibilityLabel={`Get ${label}`}
              style={styles.get}
            >
              Get
            </Button>
          )}
        </View>
      </View>
      {expanded && (
        <View style={styles.details} testID={`extension-details-${extKey}`}>
          <View style={styles.about}>
            <Text variant="bodyMedium" style={{ color: tokens.inkVariant }}>
              {description}
            </Text>
            <View style={styles.legend}>{legend}</View>
            <Text variant="bodySmall" style={[styles.note, { color: tokens.inkMuted }]}>
              {installed ? switchDescription(show) : note}
            </Text>
          </View>
          {installed && (
            <>
              {children}
              <List.Item
                title="Remove extension"
                titleStyle={{ color: theme.colors.error }}
                description={removeDescription}
                onPress={confirmRemove}
                accessibilityLabel={`Remove ${label} extension`}
              />
            </>
          )}
        </View>
      )}
    </View>
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

/** Badge 36 + gap 12 past the row's 16 padding: where the name starts. */
const TEXT_INSET = 16 + 36 + 12;

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 64 },
  rowTouch: { flex: 1, alignSelf: 'stretch', justifyContent: 'center' },
  rowInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: 16,
    paddingRight: 8,
    paddingVertical: 8,
  },
  badge: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { flex: 1, minWidth: 0 },
  titleLine: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  title: { flexShrink: 1 },
  status: { flexShrink: 0 },
  control: { paddingRight: 16, minWidth: 64, alignItems: 'flex-end' },
  get: { minWidth: 56 },
  // The details hang under the name, so they read as this entry's; its own
  // List.Items bring their 16 px padding.
  details: { paddingLeft: TEXT_INSET - 16, paddingBottom: 4 },
  about: { paddingHorizontal: 16, paddingBottom: 4 },
  legend: { marginTop: 10 },
  note: { marginTop: 8 },
});
