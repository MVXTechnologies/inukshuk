import { useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { IconButton, useTheme } from 'react-native-paper';

interface Props {
  /** Exactly what the clipboard gets: the displayed value with its datum. */
  text: string;
  /** Screen-reader label, e.g. "Copy MHHW in NAVD88". */
  label: string;
  /** Puts `text` on the clipboard and shows the toast (the screen's snackbar). */
  onCopy: (text: string) => void;
  testID?: string;
  size?: number;
}

/** How long the ✓ stays after a copy. */
export const COPIED_MS = 1500;

/**
 * A small copy button beside one value (owner requirement for the tide and
 * tidal-benchmark cards): it copies exactly what is displayed, with its
 * datum, then shows a ✓ for {@link COPIED_MS} while the screen's toast says
 * what was copied. Themed from Paper's colours, so it reads in light and dark.
 */
export function CopyValueButton({ text, label, onCopy, testID, size = 15 }: Props) {
  const theme = useTheme();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <IconButton
      icon={copied ? 'check' : 'content-copy'}
      size={size}
      iconColor={copied ? theme.colors.primary : theme.colors.onSurfaceVariant}
      style={styles.button}
      onPress={() => {
        onCopy(text);
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), COPIED_MS);
      }}
      accessibilityLabel={copied ? `${label} (copied)` : label}
      accessibilityRole="button"
      testID={testID}
      hitSlop={6}
    />
  );
}

const styles = StyleSheet.create({
  button: { margin: 0, width: 26, height: 26 },
});
