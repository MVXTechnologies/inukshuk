import { MaterialCommunityIcons } from '@expo/vector-icons';
import { FONT_FAMILY } from '@ui/fonts';
import { buildTabBarOptions, TAB_PILL, tabLabelStyle } from '@ui/tabBarStyle';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { useRecorderStore } from '@state/recorderStore';
import { palette } from '@ui/tokens';
import { Tabs, usePathname, useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View, type ColorValue } from 'react-native';
import { useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type IconName = keyof typeof MaterialCommunityIcons.glyphMap;

/**
 * Map · Library · Maps · Logbook (revamp decision 6). Settings is not a tab:
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
  const recording = useRecorderStore((s) => s.status !== 'idle');

  const icon = (name: IconName) => {
    const TabIcon = ({ color, focused }: { color: ColorValue; focused: boolean }) => (
      <View style={[styles.pill, focused && { backgroundColor: pill }]}>
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
        <Tabs.Screen name="index" options={{ title: 'Map', tabBarIcon: icon('map-outline') }} />
        <Tabs.Screen
          name="library"
          options={{ title: 'Library', tabBarIcon: icon('folder-outline') }}
        />
        <Tabs.Screen
          name="maps"
          options={{ title: 'Maps', tabBarIcon: icon('view-grid-plus-outline') }}
        />
        <Tabs.Screen
          name="logbook"
          options={{ title: 'Logbook', tabBarIcon: icon('notebook-outline') }}
        />
      </Tabs>
      {recording && !onMap && (
        <View style={[styles.returnDock, { bottom: insets.bottom + 64 }]} pointerEvents="box-none">
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
