import { useSettingsStore } from '@state/settingsStore';
import { Platform } from 'react-native';
import { List, Switch } from 'react-native-paper';

/**
 * Settings › Display › "Show phone navigation buttons" (#682). Android only:
 * iPhones have no system navigation bar to bring back, so the row is not
 * drawn there. The root layout's useAndroidImmersive applies the choice.
 */
export function NavigationButtonsSetting() {
  const value = useSettingsStore((s) => s.showNavigationButtons);
  const set = useSettingsStore((s) => s.set);
  if (Platform.OS !== 'android') return null;
  return (
    <List.Item
      title="Show phone navigation buttons"
      description="Keep Android's Back, Home and Recents buttons (or the gesture bar) on screen"
      right={() => (
        <Switch
          value={value}
          onValueChange={(v) => set('showNavigationButtons', v)}
          accessibilityLabel="Show phone navigation buttons"
        />
      )}
    />
  );
}
