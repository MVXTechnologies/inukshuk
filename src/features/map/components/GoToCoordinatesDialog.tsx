import { formatLatLng, formatLatLngDdm, formatLatLngDms } from '@core/geo/formatCoords';
import { parseLatLng } from '@core/geo/parseCoords';
import type { LatLng } from '@core/models';
import { useEffect, useState } from 'react';
import { Keyboard, Platform, StyleSheet, View } from 'react-native';
import {
  Button,
  Dialog,
  HelperText,
  Portal,
  Text,
  TextInput,
  TouchableRipple,
} from 'react-native-paper';

/**
 * Coordinate READOUT + ENTRY (#97), opened from the map-actions sheet.
 *
 * Both halves live in one dialog because they are the same question asked in
 * two directions — "where am I looking?" and "take me there" — and because a
 * dialog costs no permanent map chrome. The tap-anywhere chip
 * (`MapPointChip`) already answers "what are the coordinates HERE?" for a
 * point you can see; this answers it for the map centre, in all three
 * notations, each tappable to copy.
 *
 * With the entry box empty the dialog still has a subject: the map centre. So
 * "Set destination" with nothing typed drops the pin on the crosshair, which
 * is the fastest way to aim at something you can see on screen.
 *
 * Parsing is `@core/geo/parseCoords`, which refuses anything ambiguous rather
 * than guessing — a silently mis-read coordinate is a wrong bearing in the
 * bush, so the box stays red instead.
 */

/**
 * Current iOS keyboard height (0 on Android, which resizes the window
 * instead). Paper's Dialog is absolutely positioned by its Modal wrapper, so
 * it must be shifted explicitly or the keyboard covers its actions — the same
 * fix WaypointEditorDialog carries.
 */
function useIosKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const show = Keyboard.addListener('keyboardWillShow', (e) =>
      setHeight(e.endCoordinates.height),
    );
    const hide = Keyboard.addListener('keyboardWillHide', () => setHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return height;
}

interface Props {
  /** The map centre to read out; null before the camera has settled once. */
  center: LatLng | null;
  onDismiss: () => void;
  /** Fly the camera to a coordinate. */
  onGo: (at: LatLng) => void;
  /** Drop the destination pin on a coordinate. */
  onSetDestination: (at: LatLng) => void;
  /** Copy one formatted line to the clipboard (the caller also snackbars it). */
  onCopy: (text: string) => void;
}

/**
 * Mounted only while it is open (the caller renders it conditionally), so
 * every opening starts from a blank box with no reset effect — a stale
 * coordinate from last time is the one thing worse than none.
 */
export function GoToCoordinatesDialog({
  center,
  onDismiss,
  onGo,
  onSetDestination,
  onCopy,
}: Props) {
  const [draft, setDraft] = useState('');
  const keyboardHeight = useIosKeyboardHeight();

  const typed = draft.trim();
  const parsed = typed === '' ? null : parseLatLng(typed);
  const invalid = typed !== '' && parsed === null;
  // Empty box: the map centre is the implicit subject (see the header note).
  const target = parsed ?? (typed === '' ? center : null);

  const copyRow = (label: string, value: string) => (
    <TouchableRipple
      onPress={() => onCopy(value)}
      style={styles.row}
      accessibilityLabel={`Copy ${label.toLowerCase()}`}
      borderless
    >
      <View style={styles.rowInner}>
        <Text variant="labelSmall" style={styles.rowLabel}>
          {label}
        </Text>
        <Text variant="bodyMedium" style={styles.rowValue}>
          {value}
        </Text>
      </View>
    </TouchableRipple>
  );

  return (
    <Portal>
      <Dialog
        visible
        onDismiss={onDismiss}
        style={keyboardHeight > 0 ? { marginBottom: keyboardHeight } : null}
      >
        <Dialog.Title>Coordinates</Dialog.Title>
        <Dialog.Content>
          {center !== null ? (
            <View style={styles.readout}>
              <Text variant="labelMedium">Map centre — tap a line to copy</Text>
              {copyRow('Decimal', formatLatLng(center.latitude, center.longitude))}
              {copyRow('Deg / min', formatLatLngDdm(center.latitude, center.longitude))}
              {copyRow('Deg / min / sec', formatLatLngDms(center.latitude, center.longitude))}
            </View>
          ) : (
            <Text variant="bodyMedium">Waiting for the map to settle…</Text>
          )}
          <TextInput
            label="Go to coordinates"
            // Paper's floating `label` is a sibling Text, not the input's
            // accessible name — screen readers (and tests) need it spelled out.
            accessibilityLabel="Go to coordinates"
            value={draft}
            onChangeText={setDraft}
            mode="outlined"
            autoCapitalize="characters"
            autoCorrect={false}
            error={invalid}
            placeholder="46.8139, -71.2082"
            style={styles.input}
          />
          <HelperText type={invalid ? 'error' : 'info'} visible>
            {invalid
              ? 'Not a coordinate we can read — try 46.8139, -71.2082 or 46°48\'50"N 71°12\'29"W'
              : 'Decimal, degrees-minutes or degrees-minutes-seconds, N/S/E/W or signs.'}
          </HelperText>
        </Dialog.Content>
        <Dialog.Actions style={styles.actions}>
          <Button onPress={onDismiss}>Cancel</Button>
          <View style={styles.fill} />
          <Button disabled={target === null} onPress={() => target && onSetDestination(target)}>
            Set destination
          </Button>
          <Button
            mode="contained-tonal"
            disabled={parsed === null}
            onPress={() => parsed && onGo(parsed)}
          >
            Go
          </Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  readout: { gap: 2, marginBottom: 8 },
  row: { borderRadius: 8 },
  rowInner: { paddingVertical: 6, paddingHorizontal: 4 },
  rowLabel: { opacity: 0.7 },
  rowValue: { fontVariant: ['tabular-nums'] },
  input: { marginTop: 4 },
  // Three actions do not fit one line on a narrow phone; let them wrap.
  actions: { flexWrap: 'wrap' },
});
