import { InputAccessoryView, Keyboard, Platform, StyleSheet, View } from 'react-native';
import { Button, useTheme } from 'react-native-paper';

/**
 * #235 — iOS has no way out of a text field.
 *
 * On iOS the software keyboard carries no "hide" key. A single-line field can
 * at least be escaped with Return (once `returnKeyType`/`blurOnSubmit` are
 * wired), but on a **multiline** field Return inserts a newline and on a
 * **numeric** pad there is no Return key at all — so the user is trapped, and
 * inside a Paper `Dialog` there is nothing safe to tap either (the backdrop
 * closes the dialog rather than dismissing the keyboard). Android never showed
 * this because the back gesture always dismisses.
 *
 * The standard iOS idiom is an input accessory view: a bar pinned above the
 * keyboard. Any `TextInput` that sets `inputAccessoryViewID` to
 * {@link KEYBOARD_DONE_BAR_ID} gets this bar, with a right-aligned **Done**
 * that blurs the field. Android renders nothing (the component returns null),
 * so call sites stay platform-free.
 */

/**
 * Stable `nativeID` shared by the bar and every field that opts into it.
 * Keep it a literal constant: RN resolves the accessory by string id through
 * the native view registry, so both sides must agree exactly.
 */
export const KEYBOARD_DONE_BAR_ID = 'inukshuk-keyboard-done';

/**
 * Mount this INSIDE the dialog/screen that owns the field, after the field
 * itself — never once at the app root.
 *
 * On the New Architecture `RCTInputAccessoryComponentView` binds to its text
 * input exactly once, in `didMoveToWindow`, by walking the window for a field
 * whose `inputAccessoryViewID` matches; there is no later retry. A bar mounted
 * at launch therefore finds no field and silently does nothing — the keyboard
 * comes up bare, which is the bug we are fixing. Mounted with the dialog, the
 * field is already in the window when the bar lands, and the two find each
 * other. Paper's Modal renders nothing while hidden, so only the open dialog's
 * bar is ever live and the shared id is never claimed twice.
 *
 * NOT needed for numeric fields: RN builds its own Done toolbar for number
 * pads straight from `returnKeyType`, and skips doing so if the field carries
 * an `inputAccessoryViewID`. Give those `returnKeyType` alone.
 */
export function KeyboardDoneBar() {
  // InputAccessoryView is iOS-only; on Android the platform's own back gesture
  // already dismisses, so the bar would be foreign chrome. The gate lives in
  // this hook-free wrapper so "renders nothing on Android" stays a plain
  // function call in tests, with no renderer or theme in the way.
  if (Platform.OS !== 'ios') return null;
  return <DoneBarIos />;
}

function DoneBarIos() {
  const theme = useTheme();

  return (
    <InputAccessoryView nativeID={KEYBOARD_DONE_BAR_ID}>
      <View
        style={[
          styles.bar,
          {
            backgroundColor: theme.colors.elevation.level2,
            borderTopColor: theme.colors.outlineVariant,
          },
        ]}
      >
        <Button
          mode="text"
          compact
          onPress={() => Keyboard.dismiss()}
          // Reads "Done" (the iOS idiom, and what the owner asked for) but
          // announces itself as "Hide keyboard": VoiceOver gets the more
          // useful phrasing, and — crucially — the bar stops colliding with
          // the "Done" BUTTON that WaypointEditorDialog uses to save, which
          // `waypoint.yaml` taps while the keyboard is still up on iOS.
          accessibilityLabel="Hide keyboard"
          testID="keyboard-done"
        >
          Done
        </Button>
      </View>
    </InputAccessoryView>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
