import { MaterialCommunityIcons } from '@expo/vector-icons';
import { buildTabBarOptions } from '@ui/tabBarStyle';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Tabs } from 'expo-router';
import type { ColorValue } from 'react-native';
import { useTheme } from 'react-native-paper';

export default function TabsLayout() {
  const theme = useTheme();
  const tokens = useSchemeTokens();
  const icon = (name: keyof typeof MaterialCommunityIcons.glyphMap) => {
    const TabIcon = ({ color, size }: { color: ColorValue; size: number }) => (
      <MaterialCommunityIcons name={name} color={color} size={size} />
    );
    return TabIcon;
  };

  const tabBar = buildTabBarOptions({
    colors: {
      surface: theme.colors.elevation.level2,
      outline: theme.colors.outlineVariant,
      // Primary is stone, the same as secondary text, so the active tab takes
      // sage and inactive tabs the muted ink until the revamp's sage pill
      // lands with the new tabs (PR 3).
      active: theme.colors.secondary,
      inactive: tokens.inkMuted,
    },
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
