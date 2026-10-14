import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Text, useTheme } from 'react-native-paper';
import { palette } from '@ui/tokens';

import type { ActionSnack } from './useActionSnackbar';

/**
 * The view half of `useActionSnackbar`: a Material snackbar (inverse surface,
 * message, text actions on the right) as a plain View pinned to the bottom of
 * its parent. Never Paper's Snackbar (its timer sticks on One UI) and never a
 * Portal. Announced politely to screen readers.
 */
export function ActionSnackbar({
  snack,
  style,
}: {
  snack: ActionSnack | null;
  /** Placement, e.g. `snackbarWrapperStyle(...)` to clear the recording panel. */
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  if (snack === null) return null;
  return (
    <View style={[styles.wrap, style]} pointerEvents="box-none">
      <View
        style={[styles.bar, { backgroundColor: theme.colors.inverseSurface }]}
        accessibilityLiveRegion="polite"
        testID="action-snackbar"
      >
        <Text
          style={[styles.message, { color: theme.colors.inverseOnSurface }]}
          accessibilityRole="alert"
        >
          {snack.message}
        </Text>
        {snack.actions.map((a) => (
          <Pressable
            key={a.label}
            onPress={a.onPress}
            accessibilityRole="button"
            accessibilityLabel={a.label}
            hitSlop={6}
            style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          >
            <Text style={[styles.actionLabel, { color: theme.colors.inversePrimary }]}>
              {a.label.toUpperCase()}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 8 },
  bar: {
    minHeight: 48,
    borderRadius: 4,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 16,
    paddingRight: 8,
    elevation: 6,
    shadowColor: palette.black,
    shadowOpacity: 0.25,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
  },
  message: { flex: 1, paddingVertical: 14, fontSize: 14, lineHeight: 20 },
  action: { paddingHorizontal: 10, paddingVertical: 10, borderRadius: 4 },
  pressed: { opacity: 0.6 },
  actionLabel: { fontSize: 14, fontWeight: '700', letterSpacing: 0.5 },
});
