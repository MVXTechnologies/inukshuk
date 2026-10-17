import { Pressable, StyleSheet, View } from 'react-native';

import { useDisplayScale, useScaledStyles } from '@ui/displayScale';
import { Icon, Text } from '@ui/paper';
import { useChromeOutline } from '@ui/useChromeOutline';
import { useSchemeTokens } from '@ui/useSchemeTokens';

const BUTTON_HEIGHT = 30;
const CLOSE_ICON = 18;
const CLOSE_PAD = 4;

/**
 * The "New version" prompt (2.7.0): one line and one button in the Map's
 * bottom column, in the map chrome's colours (light and dark). A plain themed
 * View, never a Dialog or a Portal (One UI touch-swallow on the launch path)
 * and never a Paper Surface (iOS flex collapse). The button is the chrome's
 * colours swapped, so it reads in light, dark, Sunlight and Night. The close
 * button forgets this version for good; the next version asks again.
 */
export function UpdatePromptBanner({
  text,
  action,
  actionLabel,
  onAction,
  onDismiss,
}: {
  text: string;
  /** The button's word, or null for a line without a button (download running). */
  action: string | null;
  actionLabel: string | null;
  onAction: () => void;
  onDismiss: () => void;
}) {
  const styles = useScaledStyles(stylesSheet);
  const { slop } = useDisplayScale();
  const tokens = useSchemeTokens();
  const outline = useChromeOutline();
  return (
    <View
      testID="update-prompt"
      style={[styles.card, { backgroundColor: tokens.map.chrome }, outline]}
      accessibilityRole="summary"
    >
      <Text style={[styles.text, { color: tokens.map.chromeInk }]} numberOfLines={1}>
        {text}
      </Text>
      {action !== null && (
        <Pressable
          onPress={onAction}
          style={({ pressed }) => [
            styles.button,
            // The chrome's colours swapped: a pill that reads on every scheme.
            { backgroundColor: tokens.map.chromeInk, opacity: pressed ? 0.8 : 1 },
          ]}
          hitSlop={slop(BUTTON_HEIGHT)}
          accessibilityRole="button"
          accessibilityLabel={actionLabel ?? action}
          testID="update-prompt-action"
        >
          <Text style={[styles.buttonLabel, { color: tokens.map.chrome }]} numberOfLines={1}>
            {action}
          </Text>
        </Pressable>
      )}
      <Pressable
        onPress={onDismiss}
        style={styles.close}
        hitSlop={slop(CLOSE_ICON + 2 * CLOSE_PAD)}
        accessibilityRole="button"
        accessibilityLabel="Close"
        testID="update-prompt-close"
      >
        <Icon source="close" size={CLOSE_ICON} color={tokens.map.chromeInkMuted} />
      </Pressable>
    </View>
  );
}

/**
 * The row the one-line fit test measures (`UpdatePromptBanner.test.tsx`), at
 * 100 %: card padding start, the gaps, the button's padding and the close
 * button's, card padding end; the close glyph. Keep in step with the sheet.
 */
export const UPDATE_PROMPT_ROW = {
  spacing: [10, 6, 10, 10, 6, CLOSE_PAD, CLOSE_PAD, 2],
  boxes: [CLOSE_ICON],
  textSp: 13,
  buttonSp: 13,
} as const;

const stylesSheet = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    paddingLeft: 10,
    paddingRight: 2,
    paddingVertical: 6,
    gap: 6,
  },
  text: { flex: 1, fontSize: 13, lineHeight: 18, fontWeight: '500' },
  button: {
    minHeight: BUTTON_HEIGHT,
    borderRadius: 15,
    paddingHorizontal: 10,
    justifyContent: 'center',
  },
  buttonLabel: { fontSize: 13, lineHeight: 18, fontWeight: '700' },
  close: { padding: CLOSE_PAD },
});
