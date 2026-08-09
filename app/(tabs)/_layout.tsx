import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSettingsStore } from '@state/settingsStore';
import { Tabs } from 'expo-router';
import type { ColorValue } from 'react-native';
import { useTheme } from 'react-native-paper';

export default function TabsLayout() {
  const theme = useTheme();
  const uiStyle = useSettingsStore((s) => s.uiStyle);
  // Per-style tab bar: Minimal drops the icons (text-only labels, thinner
  // bar); Edge keeps icons but colours the active tab in the pastel-river
  // blue of the "+" dial instead of sage.
  const minimal = uiStyle === 'minimal';
  const icon = (name: keyof typeof MaterialCommunityIcons.glyphMap) => {
    const TabIcon = ({ color, size }: { color: ColorValue; size: number }) =>
      minimal ? null : <MaterialCommunityIcons name={name} color={color} size={size} />;
    return TabIcon;
  };

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        // Theme the scene background too, else it defaults to light and shows
        // through the (transparent) screen roots — unreadable in dark mode.
        sceneStyle: { backgroundColor: theme.colors.background },
        tabBarActiveTintColor: uiStyle === 'edge' ? theme.colors.tertiary : theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.onSurfaceVariant,
        tabBarStyle: {
          backgroundColor: theme.colors.elevation.level2,
          borderTopColor: theme.colors.outlineVariant,
          ...(minimal ? { height: 56 } : {}),
        },
        ...(minimal
          ? {
              tabBarIconStyle: { display: 'none' as const },
              tabBarLabelStyle: { fontSize: 13, fontWeight: '500' as const },
              tabBarItemStyle: { justifyContent: 'center' as const },
            }
          : {}),
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
