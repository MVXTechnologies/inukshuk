import type { TextStyle, ViewStyle } from 'react-native';

/**
 * Bottom tab bar styling (revamp board `Main.html`), as a pure function of
 * the theme colours: paper level-2 bar with a hairline, stone ink on a 60×30
 * sage pill for the active tab, muted ink for the rest, 12 dp labels.
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
  /** Active icon + label ink — `theme.colors.onSecondaryContainer`. */
  active: string;
  /** Inactive icon + label ink — the muted ink token. */
  inactive: string;
};

export type TabBarOptions = {
  tabBarActiveTintColor: string;
  tabBarInactiveTintColor: string;
  tabBarStyle: ViewStyle;
  tabBarIconStyle: ViewStyle;
};

/** The active-tab pill behind the icon. */
export const TAB_PILL = { width: 60, height: 30, borderRadius: 15 } as const;

/** Label type: 12 dp, heavier on the active tab. */
export function tabLabelStyle(focused: boolean, fontFamily: string): TextStyle {
  return { fontSize: 12, lineHeight: 16, fontFamily, fontWeight: focused ? '800' : '700' };
}

/** Build the `screenOptions` slice that drives the bottom tab bar. */
export function buildTabBarOptions({ colors }: { colors: TabBarColors }): TabBarOptions {
  return {
    tabBarActiveTintColor: colors.active,
    tabBarInactiveTintColor: colors.inactive,
    tabBarStyle: {
      backgroundColor: colors.surface,
      borderTopColor: colors.outline,
    },
    // Room for the pill; the library otherwise sizes the icon slot to the glyph.
    tabBarIconStyle: { width: TAB_PILL.width, height: TAB_PILL.height },
  };
}
