import { palette } from '@ui/tokens';
import { StyleSheet, View } from 'react-native';
import { Icon, Text, TouchableRipple } from 'react-native-paper';
import { weatherChrome as wc } from '../weather/weatherChrome';

/**
 * "Following · Sentier des Crêtes" (#678): what the compass is guiding you
 * along, with the ✕ that stops it. The destination chip's twin — same lane
 * (top centre), same fixed dark slab in both themes, the trail's orange
 * route mark instead of the sage flag.
 */
export function FollowChip({ name, onStop }: { name: string; onStop: () => void }) {
  return (
    <View style={styles.chip}>
      <Icon source="map-marker-path" size={16} color={palette.route} />
      <Text style={styles.text} numberOfLines={1}>
        Following · {name}
      </Text>
      <TouchableRipple
        onPress={onStop}
        style={styles.clear}
        accessibilityLabel="Stop following"
        accessibilityRole="button"
        borderless
      >
        <Icon source="close" size={15} color={wc.inkMuted} />
      </TouchableRipple>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: '100%',
    backgroundColor: wc.panel,
    borderRadius: 15,
    paddingLeft: 10,
    paddingRight: 4,
    paddingVertical: 5,
  },
  text: { flexShrink: 1, fontSize: 13, lineHeight: 17, fontWeight: '700', color: wc.ink },
  clear: { borderRadius: 12, padding: 5 },
});
