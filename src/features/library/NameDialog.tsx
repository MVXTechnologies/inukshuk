import { useRef } from 'react';
import { Button, Dialog, TextInput } from 'react-native-paper';

interface Props {
  visible: boolean;
  title: string;
  label: string;
  confirmLabel?: string;
  /** Pre-filled text (rename flows); the field remounts blank-or-this per open. */
  initialValue?: string;
  onDismiss: () => void;
  /** Called with the trimmed name (may be empty — caller applies its default). */
  onSubmit: (name: string) => void;
}

/**
 * A name-prompt dialog whose TextInput is uncontrolled. When the input was
 * controlled by LibraryScreen, every keystroke re-rendered the whole (large)
 * screen; on-device that render lag made the controlled value fall behind
 * fast typing and RN's native↔JS text sync reordered characters ("letters
 * and spaces mix"). Uncontrolled, the native field owns the text — we only
 * read it at submit — and the input remounts per open (key) so each prompt
 * starts blank.
 */
export function NameDialog({
  visible,
  title,
  label,
  confirmLabel = 'Create',
  initialValue = '',
  onDismiss,
  onSubmit,
}: Props) {
  // null = the user hasn't typed since the dialog opened → submit initialValue.
  const typedRef = useRef<string | null>(null);

  const submit = () => {
    const name = (typedRef.current ?? initialValue).trim();
    typedRef.current = null;
    onSubmit(name);
  };
  const dismiss = () => {
    typedRef.current = null;
    onDismiss();
  };

  return (
    <Dialog visible={visible} onDismiss={dismiss}>
      <Dialog.Title>{title}</Dialog.Title>
      <Dialog.Content>
        <TextInput
          key={`${visible}-${initialValue}`}
          label={label}
          defaultValue={initialValue}
          onChangeText={(t) => {
            typedRef.current = t;
          }}
          autoFocus
          onSubmitEditing={submit}
        />
      </Dialog.Content>
      <Dialog.Actions>
        <Button onPress={dismiss}>Cancel</Button>
        <Button onPress={submit}>{confirmLabel}</Button>
      </Dialog.Actions>
    </Dialog>
  );
}
