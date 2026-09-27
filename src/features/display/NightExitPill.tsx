import { autoNightDismissalEnd } from '@core/display/condition';
import { sunTimes } from '@core/sun/sunTimes';
import { useDisplayStore } from '@state/displayStore';
import { useSettingsStore } from '@state/settingsStore';
import { nightScheme, palette } from '@ui/tokens';
import { Pressable, StyleSheet } from 'react-native';
import { Icon, Text } from 'react-native-paper';

/**
 * "Night on · tap to exit" (`After-Night.html`). If Night red was chosen, the
 * tap returns to Normal; if it came from "Auto night at sunset", the tap
 * silences it until sunrise without turning the toggle off.
 */
export function NightExitPill() {
  const chosen = useSettingsStore((s) => s.displayCondition);
  const set = useSettingsStore((s) => s.set);
  const position = useSettingsStore((s) => s.lastKnownPosition);
  const dismissAutoNight = useDisplayStore((s) => s.dismissAutoNight);

  const exit = () => {
    if (chosen === 'night') {
      set('displayCondition', 'normal');
      return;
    }
    const now = Date.now();
    const sun = position === null ? null : sunTimes(now, position.latitude, position.longitude);
    dismissAutoNight(autoNightDismissalEnd(now, sun));
  };

  return (
    <Pressable
      onPress={exit}
      accessibilityRole="button"
      accessibilityLabel="Night on, tap to exit"
      style={[styles.pill, { borderColor: nightScheme.outline }]}
    >
      <Icon source="weather-night" size={16} color={nightScheme.ink} />
      <Text style={[styles.text, { color: nightScheme.ink }]}>Night on · tap to exit</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: palette.black,
  },
  text: { fontSize: 14, fontWeight: '700' },
});
