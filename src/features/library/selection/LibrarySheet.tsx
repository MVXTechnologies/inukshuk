import { palette, space, target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { IconButton, Text, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useScreenSheet } from '../../common/useScreenSheet';

/**
 * The Library's bottom sheets (#711: Move to…, Share): a plain themed View
 * over a scrim, never a Paper Portal/Dialog (the touch-swallow trap on One
 * UI). A drag handle, a title with its subtitle and ✕, then the rows. Back,
 * ✕ and a tap on the scrim all close it.
 */
export function LibrarySheet({
  visible,
  focused,
  title,
  subtitle,
  onClose,
  testID,
  children,
}: {
  visible: boolean;
  /** The Library is the screen in front (Back is only ours then). */
  focused: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  testID?: string;
  children: ReactNode;
}) {
  useScreenSheet(visible && focused, onClose);
  const t = useSchemeTokens();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  if (!visible) return null;
  return (
    <View style={StyleSheet.absoluteFill} testID={testID}>
      <Pressable
        style={[styles.scrim, { backgroundColor: theme.dark ? SCRIM_DARK : SCRIM_LIGHT }]}
        onPress={onClose}
        accessibilityLabel="Close"
        accessibilityRole="button"
        importantForAccessibility="no"
      />
      <View
        style={[
          styles.sheet,
          {
            backgroundColor: theme.dark ? t.elevation.level1 : t.surface,
            paddingBottom: insets.bottom + space.md,
          },
        ]}
        accessibilityViewIsModal
      >
        <View style={[styles.handle, { backgroundColor: t.outline }]} />
        <View style={styles.head}>
          <View style={styles.headText}>
            <Text accessibilityRole="header" style={[styles.title, { color: t.ink }]}>
              {title}
            </Text>
            {subtitle ? (
              <Text numberOfLines={1} style={[styles.subtitle, { color: t.inkMuted }]}>
                {subtitle}
              </Text>
            ) : null}
          </View>
          <IconButton
            icon="close"
            iconColor={t.inkMuted}
            onPress={onClose}
            style={styles.close}
            accessibilityLabel="Close"
          />
        </View>
        <ScrollView style={styles.body} bounces={false}>
          {children}
        </ScrollView>
      </View>
    </View>
  );
}

/** A 56 dp sheet row: a 40 dp icon tile, a label with an optional line under it, and a trailing bit. */
export function SheetRow({
  icon,
  label,
  labelSuffix,
  detail,
  trailing,
  accent,
  big,
  onPress,
  accessibilityLabel,
  testID,
}: {
  icon: ReactNode;
  label: string;
  /** Muted words after the label ("· current"). */
  labelSuffix?: string;
  detail?: ReactNode;
  trailing?: ReactNode;
  /** The sage tile (the row's primary choice). */
  accent?: boolean;
  /** 72 dp, 48 dp tile (the Share sheet's one choice). */
  big?: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
  testID?: string;
}) {
  const t = useSchemeTokens();
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      style={({ pressed }) => [
        styles.row,
        big && styles.rowBig,
        pressed && { backgroundColor: t.surfaceVariant },
      ]}
    >
      <View
        style={[
          styles.tile,
          big && styles.tileBig,
          { backgroundColor: accent ? theme.colors.secondaryContainer : t.surfaceVariant },
        ]}
      >
        {icon}
      </View>
      <View style={styles.rowText}>
        <Text numberOfLines={1} style={[styles.rowLabel, { color: t.ink }]}>
          {label}
          {labelSuffix ? (
            <Text style={[styles.suffix, { color: t.inkMuted }]}>{` ${labelSuffix}`}</Text>
          ) : null}
        </Text>
        {detail}
      </View>
      {trailing}
    </Pressable>
  );
}

export function SheetDivider() {
  const t = useSchemeTokens();
  return <View style={[styles.divider, { backgroundColor: t.outlineVariant }]} />;
}

const SCRIM_LIGHT = 'rgba(20,24,28,0.40)';
const SCRIM_DARK = 'rgba(0,0,0,0.55)';

export const sheetStyles = StyleSheet.create({
  detail: { fontSize: 12.5, lineHeight: 17, fontWeight: '600' },
});

const styles = StyleSheet.create({
  scrim: { ...StyleSheet.absoluteFill },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '85%',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: space.sm,
    elevation: 8,
    shadowColor: palette.black,
    shadowOpacity: 0.25,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: -8 },
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    opacity: 0.6,
    alignSelf: 'center',
    marginTop: space.xs,
    marginBottom: 10,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingLeft: 20,
    paddingRight: space.sm,
    paddingBottom: space.xs,
  },
  headText: { flex: 1, minWidth: 0 },
  title: { fontSize: 20, lineHeight: 25, fontWeight: '800' },
  subtitle: { fontSize: 13, lineHeight: 17, fontWeight: '600' },
  close: { margin: 0, width: target.min, height: target.min },
  body: { flexGrow: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    minHeight: 56,
    paddingVertical: 6,
    paddingLeft: 20,
    paddingRight: space.md,
  },
  rowBig: { minHeight: 72 },
  tile: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileBig: { width: 48, height: 48, borderRadius: 14 },
  rowText: { flex: 1, minWidth: 0 },
  rowLabel: { fontSize: 16, lineHeight: 21, fontWeight: '700' },
  suffix: { fontSize: 13, fontWeight: '600' },
  divider: { height: 1, marginVertical: 6, marginHorizontal: 20 },
});
