import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSettingsStore } from '@state/settingsStore';
import { buildTabBarOptions } from '@ui/tabBarStyle';
import { Tabs } from 'expo-router';
import type { ColorValue } from 'react-native';
import { useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function TabsLayout() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const uiStyle = useSettingsStore((s) => s.uiStyle);
  // Per-style tab bar: Minimal drops the icons (text-only labels, fixed
  // thinner bar); Edge keeps icons but colours the active tab in the
  // pastel-river blue of the "+" dial instead of sage. The style/inset
  // arithmetic lives in @ui/tabBarStyle so it can be unit-tested.
  const minimal = uiStyle === 'minimal';
  const icon = (name: keyof typeof MaterialCommunityIcons.glyphMap) => {
    const TabIcon = ({ color, size }: { color: ColorValue; size: number }) =>
      minimal ? null : <MaterialCommunityIcons name={name} color={color} size={size} />;
    return TabIcon;
  };

  const tabBar = buildTabBarOptions({
    uiStyle,
    colors: {
      surface: theme.colors.elevation.level2,
      outline: theme.colors.outlineVariant,
      primary: theme.colors.primary,
      tertiary: theme.colors.tertiary,
      onSurfaceVariant: theme.colors.onSurfaceVariant,
    },
    insets,
  });

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        // Theme the scene background too, else it defaults to light and shows
        // through the (transparent) screen roots — unreadable in dark mode.
        sceneStyle: { backgroundColor: theme.colors.background },
        ...tabBar,
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Map', tabBarIcon: icon('map') }} />
      <Tabs.Screen
        name="library"
        options={{ title: 'Library', tabBarIcon: icon('folder-multiple-outline') }}
      />
      <Tabs.Screen name="search" options={{ title: 'Search', tabBarIcon: icon('magnify') }} />
      <Tabs.Screen
        name="dashboard"
        options={{ title: 'Dashboard', tabBarIcon: icon('chart-timeline-variant') }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: 'Settings', tabBarIcon: icon('cog-outline') }}
      />
    </Tabs>
  );
}
