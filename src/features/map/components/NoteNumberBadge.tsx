import { StyleSheet, Text, View } from 'react-native';

/**
 * Numbered circle pin for a trail note on the map. Colours are fixed (not
 * themed): the badge sits on map tiles, which look the same in light and dark
 * mode, and they match the numbered badges beside the notes list and along the
 * elevation profile so map ↔ list correspondence is obvious.
 */
const BADGE_BG = '#4F7A3A'; // same green as the notes-list badge
const BADGE_SIZE = 24;

/** `size`: the badge's diameter (dp), 24 by default; the map's follows Pin size (#742). */
export function NoteNumberBadge({ num, size = BADGE_SIZE }: { num: number; size?: number }) {
  const k = size / BADGE_SIZE;
  return (
    <View
      style={[styles.badge, { width: size, height: size, borderRadius: size / 2 }]}
      pointerEvents="none"
      testID={`note-badge-${num}`}
    >
      <Text
        style={[styles.text, { fontSize: 11 * k, lineHeight: 14 * k }]}
        allowFontScaling={false}
      >
        {num}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    backgroundColor: BADGE_BG,
    borderWidth: 2,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { color: '#FFFFFF', fontWeight: '700' },
});
