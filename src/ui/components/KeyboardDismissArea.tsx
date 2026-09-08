import type { ReactNode } from 'react';
import { Keyboard, Pressable, type StyleProp, type ViewStyle } from 'react-native';

/**
 * #235 — "tap somewhere neutral to put the keyboard away", inside a dialog.
 *
 * Outside a dialog that gesture is free (the screen behind the field absorbs
 * it); inside a Paper `Dialog` it is not, because the only thing outside the
 * content is the backdrop, and tapping the backdrop *closes the dialog*. So
 * the dialog's own body has to offer it: this wraps content in a Pressable
 * whose press only dismisses the keyboard.
 *
 * Nested touchables still win the responder — a tap on a Button inside runs
 * the Button, not this — so wrapping a whole `Dialog.Content` is safe.
 * `accessible={false}` keeps the wrapper out of the accessibility tree so the
 * children stay individually reachable (screen readers and E2E alike).
 */
export function KeyboardDismissArea({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable accessible={false} onPress={() => Keyboard.dismiss()} style={style}>
      {children}
    </Pressable>
  );
}
