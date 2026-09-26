import type { ViewStyle } from 'react-native';

/**
 * Bottom tab bar colours, as a pure function of the theme. There is one tab
 * bar look since the Minimal and Edge styles were retired (revamp PR 2).
 *
 * The bar deliberately sets no `height`: a fixed height in `tabBarStyle`
 * replaces React Navigation's computed `base + insets.bottom` while the
 * library still pads by the inset, which ate the label row on devices with a
 * home indicator (#251). The test pins that.
 */

/** The theme colours the tab bar needs. */
export type TabBarColors = {
  /** Bar background — `theme.colors.elevation.level2`. */
  surface: string;
  /** Hairline top border — `theme.colors.outlineVariant`. */
  outline: string;
  /** Active tab tint. */
  active: string;
  /** Inactive tab tint. */
  inactive: string;
};

export type TabBarOptions = {
  tabBarActiveTintColor: string;
  tabBarInactiveTintColor: string;
  tabBarStyle: ViewStyle;
};

/** Build the `screenOptions` slice that drives the bottom tab bar. */
export function buildTabBarOptions({ colors }: { colors: TabBarColors }): TabBarOptions {
  return {
    tabBarActiveTintColor: colors.active,
    tabBarInactiveTintColor: colors.inactive,
    tabBarStyle: {
      backgroundColor: colors.surface,
      borderTopColor: colors.outline,
    },
  };
}
