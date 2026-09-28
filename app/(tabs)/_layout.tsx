import { MaterialCommunityIcons } from '@expo/vector-icons';
import { FONT_FAMILY } from '@ui/fonts';
import { buildTabBarOptions, TAB_PILL, tabBarBottomInset, tabLabelStyle } from '@ui/tabBarStyle';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRecorderStore } from '@state/recorderStore';
import { palette } from '@ui/tokens';
import { Tabs, usePathname, useRouter } from 'expo-router';
import { Platform, Pressable, StyleSheet, Text, View, type ColorValue } from 'react-native';
import { useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type IconName = keyof typeof MaterialCommunityIcons.glyphMap;

const TAB_COUNT = 4;

/**
 * The label React Navigation builds for a tab whose label is a plain string
 * ("Library, tab, 2 of 4"). The label here is a render function (the active
 * tab is heavier), which makes the library skip it, and iOS then merges the
 * children's text instead. Kept identical so VoiceOver and the Maestro
 * 'Library(, tab.*)?' selectors read what they always did.
 */
function tabA11yLabel(title: string, position: number): string {
  return `${title}, tab, ${position} of ${TAB_COUNT}`;
}

/**
 * Map · Library · Explore · Logbook (revamp decision 6; the store tab was
 * "Maps" until 2.0.0 — renamed next to "Map", owner call). Settings is not a tab:
 * it is a stack route reached from the Library and Logbook headers and the
 * map's "+" sheet. Maps is the old "Search" (the store); Logbook the old
 * Dashboard.
 */
export default function TabsLayout() {
  const theme = useTheme();
  const tokens = useSchemeTokens();
  const pill = theme.colors.secondaryContainer;
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const bottomInset = tabBarBottomInset(insets.bottom, Platform.OS);
  const recording = useRecorderStore((s) => s.status !== 'idle');

  const icon = (name: IconName) => {
    // Hidden from accessibility: the glyph is an icon-font character, and
    // left exposed it prefixes the tab's label ("󰉖, Library"), which breaks
    // VoiceOver/TalkBack and every Maestro 'Library(, tab.*)?' selector.
    const TabIcon = ({ color, focused }: { color: ColorValue; focused: boolean }) => (
      <View
        style={[styles.pill, focused && { backgroundColor: pill }]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <MaterialCommunityIcons name={name} color={color} size={22} />
      </View>
    );
    return TabIcon;
  };
  const label = ({
    focused,
    color,
    children,
  }: {
    focused: boolean;
    color: ColorValue;
    children: string;
  }) => (
    <Text style={[tabLabelStyle(focused, FONT_FAMILY), { color }]} maxFontSizeMultiplier={1.3}>
      {children}
    </Text>
  );

  const tabBar = buildTabBarOptions({
    colors: {
      surface: theme.colors.elevation.level2,
      outline: theme.colors.outlineVariant,
      active: theme.colors.onSecondaryContainer,
      inactive: tokens.inkMuted,
    },
  });

  // While recording, the Map tab hides the tab bar (revamp §3: the panel
  // owns the bottom edge); the other tabs keep it and show a way back.
  const onMap = pathname === '/';
  return (
    <View style={styles.fill}>
      <Tabs
        safeAreaInsets={{ bottom: bottomInset }}
        screenOptions={({ route }) => ({
          headerShown: false,
          // Theme the scene background too, else it defaults to light and shows
          // through the (transparent) screen roots — unreadable in dark mode.
          sceneStyle: { backgroundColor: theme.colors.background },
          tabBarLabel: label,
          ...tabBar,
          tabBarStyle:
            recording && route.name === 'index'
              ? { ...tabBar.tabBarStyle, display: 'none' }
              : tabBar.tabBarStyle,
        })}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: 'Map',
            tabBarIcon: icon('map-outline'),
            tabBarAccessibilityLabel: tabA11yLabel('Map', 1),
          }}
        />
        <Tabs.Screen
          name="library"
          options={{
            title: 'Library',
            tabBarIcon: icon('folder-outline'),
            tabBarAccessibilityLabel: tabA11yLabel('Library', 2),
          }}
        />
        <Tabs.Screen
          name="maps"
          options={{
            title: 'Explore',
            tabBarIcon: icon('magnify'),
            tabBarAccessibilityLabel: tabA11yLabel('Explore', 3),
          }}
        />
        <Tabs.Screen
          name="logbook"
          options={{
            title: 'Logbook',
            tabBarIcon: icon('notebook-outline'),
            tabBarAccessibilityLabel: tabA11yLabel('Logbook', 4),
          }}
        />
      </Tabs>
      {recording && !onMap && (
        <View style={[styles.returnDock, { bottom: bottomInset + 64 }]} pointerEvents="box-none">
          <Pressable
            onPress={() => router.navigate('/')}
            accessibilityRole="button"
            accessibilityLabel="Recording, tap to return to the map"
            style={[styles.returnPill, { backgroundColor: palette.stone }]}
          >
            <View style={[styles.recDot, { backgroundColor: tokens.status.recordingDot }]} />
            <Text style={[styles.returnText, { fontFamily: FONT_FAMILY }]}>
              Recording, tap to return
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  returnDock: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  returnPill: {
    height: 44,
    borderRadius: 22,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  recDot: { width: 9, height: 9, borderRadius: 5 },
  returnText: { color: palette.paper, fontSize: 14, fontWeight: '700' },
  pill: {
    width: TAB_PILL.width,
    height: TAB_PILL.height,
    borderRadius: TAB_PILL.borderRadius,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
