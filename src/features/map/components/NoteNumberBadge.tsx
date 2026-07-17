import { StyleSheet, Text, View } from 'react-native';

/**
 * Numbered circle pin for a trail note on the map. Colours are fixed (not
 * themed): the badge sits on map tiles, which look the same in light and dark
 * mode, and they match the numbered badges beside the notes list and along the
 * elevation profile so map ↔ list correspondence is obvious.
 */
const BADGE_BG = '#4F7A3A'; // same green as the notes-list badge
const BADGE_SIZE = 24;

export function NoteNumberBadge({ num }: { num: number }) {
  return (
    <View style={styles.badge} pointerEvents="none">
      <Text style={styles.text} allowFontScaling={false}>
        {num}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    width: BADGE_SIZE,
    height: BADGE_SIZE,
    borderRadius: BADGE_SIZE / 2,
    backgroundColor: BADGE_BG,
    borderWidth: 2,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { color: '#FFFFFF', fontWeight: '700', fontSize: 11, lineHeight: 14 },
});
