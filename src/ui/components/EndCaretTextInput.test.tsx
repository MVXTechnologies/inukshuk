import { fireEvent, render, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';
import { EndCaretTextInput } from './EndCaretTextInput';

it('opens with the caret after the existing text, then lets the user move it', async () => {
  await render(
    <PaperProvider>
      <EndCaretTextInput
        label="Note"
        testID="note"
        value="Water fountain"
        onChangeText={() => {}}
      />
    </PaperProvider>,
  );
  const field = screen.getByTestId('note');
  expect(field.props.selection).toEqual({ start: 14, end: 14 });
  await fireEvent(field, 'selectionChange', { nativeEvent: { selection: { start: 3, end: 3 } } });
  expect(screen.getByTestId('note').props.selection).toBeUndefined();
});
