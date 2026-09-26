import { MaterialCommunityIcons } from '@expo/vector-icons';
import { FONT_FAMILY } from '@ui/fonts';
import { buildTabBarOptions, TAB_PILL, tabLabelStyle } from '@ui/tabBarStyle';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Tabs } from 'expo-router';
import { StyleSheet, Text, View, type ColorValue } from 'react-native';
import { useTheme } from 'react-native-paper';

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

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        // Theme the scene background too, else it defaults to light and shows
        // through the (transparent) screen roots — unreadable in dark mode.
        sceneStyle: { backgroundColor: theme.colors.background },
        tabBarLabel: label,
        ...tabBar,
      }}
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
  );
}

const styles = StyleSheet.create({
  pill: {
    width: TAB_PILL.width,
    height: TAB_PILL.height,
    borderRadius: TAB_PILL.borderRadius,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
