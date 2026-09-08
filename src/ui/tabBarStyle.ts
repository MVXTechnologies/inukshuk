import type { UiStyle } from '@ui/theme';
import type { TextStyle, ViewStyle } from 'react-native';

/**
 * Bottom tab bar styling per UI style, as a pure function of the theme colours
 * and the safe-area insets.
 *
 * Why this is not inline in `app/(tabs)/_layout.tsx`: the Minimal style pins a
 * fixed bar height, and a fixed `height` in `tabBarStyle` *replaces* React
 * Navigation's computed `base + insets.bottom` (see `getTabBarHeight` in
 * @react-navigation/bottom-tabs) while the library still applies
 * `paddingBottom: insets.bottom`. On a device with a bottom inset that ate the
 * whole label row (#251). Keeping the arithmetic here makes it unit-testable.
 */

/** Content height of the Minimal bar, above the safe-area inset. */
export const MINIMAL_TAB_BAR_CONTENT_HEIGHT = 56;

/** The theme colours the tab bar needs. Mirrors the MD3 names Paper uses. */
export type TabBarColors = {
  /** Bar background — `theme.colors.elevation.level2`. */
  surface: string;
  /** Hairline top border — `theme.colors.outlineVariant`. */
  outline: string;
  /** Active tint for classic/minimal — `theme.colors.primary`. */
  primary: string;
  /** Active tint for edge (the pastel-river blue of the "+" dial). */
  tertiary: string;
  /** Inactive tint — `theme.colors.onSurfaceVariant`. */
  onSurfaceVariant: string;
};

/** Only the bottom inset matters for a bottom tab bar. */
export type TabBarInsets = { bottom: number };

export type TabBarOptions = {
  tabBarActiveTintColor: string;
  tabBarInactiveTintColor: string;
  tabBarStyle: ViewStyle;
  tabBarIconStyle?: ViewStyle;
  tabBarLabelStyle?: TextStyle;
};

/**
 * Build the `screenOptions` slice that drives the bottom tab bar.
 *
 * - `classic` / `edge`: no `height`, so React Navigation sizes the bar itself
 *   (49 + `insets.bottom` on UIKit). These must stay byte-for-byte what they
 *   were before #251 — only the active tint differs between them.
 * - `minimal`: icons hidden and a deliberately fixed bar height, so the inset
 *   has to be added explicitly and reserved with `paddingBottom`. The label is
 *   centred in the remaining space with auto margins, because the library
 *   lays tab items out with `justifyContent: 'flex-start'` and does not
 *   forward `tabBarItemStyle` to that flex container.
 */
export function buildTabBarOptions({
  uiStyle,
  colors,
  insets,
}: {
  uiStyle: UiStyle;
  colors: TabBarColors;
  insets: TabBarInsets;
}): TabBarOptions {
  const base: TabBarOptions = {
    tabBarActiveTintColor: uiStyle === 'edge' ? colors.tertiary : colors.primary,
    tabBarInactiveTintColor: colors.onSurfaceVariant,
    tabBarStyle: {
      backgroundColor: colors.surface,
      borderTopColor: colors.outline,
    },
  };

  if (uiStyle !== 'minimal') return base;

  const bottom = Math.max(0, insets.bottom);
  return {
    ...base,
    tabBarStyle: {
      ...base.tabBarStyle,
      height: MINIMAL_TAB_BAR_CONTENT_HEIGHT + bottom,
      paddingBottom: bottom,
    },
    tabBarIconStyle: { display: 'none' },
    tabBarLabelStyle: { fontSize: 13, fontWeight: '500', marginVertical: 'auto' },
  };
}
