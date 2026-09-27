import { palette } from '@ui/tokens';
import { useSchemeTokens } from '@ui/useSchemeTokens';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from 'react-native-paper';

const SIZE = 64;
const DOT = 22;

/**
 * The idle Record button (revamp `Main.html`, proposal "Trail Mode"): recording
 * is the app's core job, so it leaves the "+" sheet for the thumb zone — a 64 dp
 * stone circle with a paper ring and a white dot, bottom-centre, with a
 * "Record" chip under it. The "+" sheet keeps its "Record track" row until the
 * Maestro flows migrate to this button.
 */
export function RecordButton({ onPress }: { onPress: () => void }) {
  const tokens = useSchemeTokens();
  return (
    <View style={styles.column} pointerEvents="box-none">
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel="Record a track"
        style={({ pressed }) => [
          styles.button,
          { borderColor: palette.paper, backgroundColor: palette.stone },
          pressed && styles.pressed,
        ]}
      >
        <View style={[styles.dot, { backgroundColor: palette.white }]} />
      </Pressable>
      <View
        style={[styles.chip, { backgroundColor: tokens.map.chip }]}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Text style={[styles.chipLabel, { color: tokens.map.chipInk }]}>Record</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  column: { alignItems: 'center', gap: 6 },
  button: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: palette.shadow,
    shadowOpacity: 0.35,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  pressed: { opacity: 0.85 },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2 },
  chip: { paddingHorizontal: 10, paddingVertical: 2, borderRadius: 10 },
  chipLabel: { fontSize: 12, fontWeight: '700', letterSpacing: 0.24 },
});
