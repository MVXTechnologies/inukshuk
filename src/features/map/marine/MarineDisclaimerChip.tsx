import { MARINE_DISCLAIMER } from '@core/geo/marineLayers';
import { StyleSheet, View } from 'react-native';
import { Icon, Surface, Text, useTheme } from 'react-native-paper';

/**
 * The mandatory "Not for navigation" notice (marine M3): a small persistent
 * chip shown whenever any marine layer is draped on the map — the CHS NONNA
 * licence is explicitly non-navigational. Same idiom as the StatsHud GPS
 * warning: a plain themed Surface pill, never a Portal/Dialog (launch-path
 * overlays soft-lock on One UI — see [[paper-portal-touch-swallow]]).
 * Colours ride the theme's error-container pair so it reads clearly on both
 * light and dark maps.
 */
export function MarineDisclaimerChip() {
  const theme = useTheme();
  return (
    <Surface
      style={[styles.chip, { backgroundColor: theme.colors.errorContainer }]}
      elevation={2}
      accessibilityLabel="Not for navigation"
    >
      <View style={styles.row}>
        <Icon source="anchor" size={14} color={theme.colors.onErrorContainer} />
        <Text
          variant="labelSmall"
          style={{ color: theme.colors.onErrorContainer, fontWeight: '700' }}
        >
          {MARINE_DISCLAIMER}
        </Text>
      </View>
    </Surface>
  );
}

const styles = StyleSheet.create({
  chip: {
    borderRadius: 14,
    paddingVertical: 4,
    paddingHorizontal: 10,
    alignSelf: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
});
