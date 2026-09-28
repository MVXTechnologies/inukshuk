import { useState, type ComponentProps } from 'react';
import { TextInput } from 'react-native-paper';

type Props = ComponentProps<typeof TextInput> & { value: string };

/**
 * A text field that opens with the caret AFTER the existing text. An
 * autofocused multiline field otherwise starts with the caret at position 0,
 * so editing a note typed in front of its first letter (owner report,
 * 2026-09-28). The caret is placed once, when the field mounts — dialogs
 * mount their content on open — and control goes back to the user at the
 * first selection event (a tap, a drag, a keystroke).
 */
export function EndCaretTextInput({ value, onSelectionChange, ...rest }: Props) {
  const [pinned, setPinned] = useState(true);
  return (
    <TextInput
      {...rest}
      value={value}
      selection={pinned ? { start: value.length, end: value.length } : undefined}
      onSelectionChange={(e) => {
        if (pinned) setPinned(false);
        onSelectionChange?.(e);
      }}
    />
  );
}
