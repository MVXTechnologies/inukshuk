import { space, target } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { IconButton, Text } from 'react-native-paper';

/**
 * The one header row of the tab screens (Library, Explore, Logbook): the
 * board's 52 dp row, 16 dp left / 4 dp right, a left-aligned 28/800 title,
 * then 48 dp actions ending in the Settings gear.
 *
 * One component on purpose: Paper's Appbar centres its title on iOS, sits
 * taller and pads its actions differently, so screens built on it put the
 * gear a few points off the Library's and it visibly jumped when switching
 * tabs (owner, 2026-09-28). The safe-area top inset stays with the screen,
 * which also owns the contour texture behind the row.
 */
export function ScreenHeader({
  title,
  onBack,
  children,
}: {
  title: string;
  /** Shows a back arrow and the smaller sub-screen title (e.g. an Explore list). */
  onBack?: () => void;
  /** Actions placed before the Settings gear. */
  children?: ReactNode;
}) {
  const tokens = useSchemeTokens();
  const router = useRouter();
  return (
    <View style={[styles.header, onBack && styles.headerWithBack]}>
      {onBack && <HeaderAction icon="arrow-left" onPress={onBack} accessibilityLabel="Back" />}
      <Text
        accessibilityRole="header"
        numberOfLines={1}
        // 360 dp phones: shrink a little rather than truncate.
        adjustsFontSizeToFit
        minimumFontScale={0.8}
        style={[onBack ? styles.subTitle : styles.title, { color: tokens.ink }]}
      >
        {title}
      </Text>
      {children}
      {/* Settings left the tab bar (revamp decision 6): the gear ends every tab header. */}
      <HeaderAction
        icon="cog-outline"
        onPress={() => router.push('/settings')}
        accessibilityLabel="Settings"
      />
    </View>
  );
}

/** A 48 dp header icon button, the size and colour every tab header uses. */
export function HeaderAction({
  icon,
  onPress,
  accessibilityLabel,
  disabled,
  size,
}: {
  icon: string;
  onPress: () => void;
  accessibilityLabel: string;
  disabled?: boolean;
  size?: number;
}) {
  const tokens = useSchemeTokens();
  return (
    <IconButton
      icon={icon}
      size={size}
      iconColor={tokens.ink}
      style={styles.action}
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={accessibilityLabel}
    />
  );
}

const styles = StyleSheet.create({
  header: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: space.lg,
    paddingRight: space.xs,
    gap: 2,
  },
  // The back arrow's own 48 dp box already carries the left breathing room.
  headerWithBack: { paddingLeft: space.xs },
  title: { flex: 1, fontSize: 28, lineHeight: 34, fontWeight: '800', letterSpacing: -0.3 },
  subTitle: { flex: 1, fontSize: 20, lineHeight: 26, fontWeight: '700' },
  action: { margin: 0, width: target.min, height: target.min },
});
