import { fireEvent, render, screen } from '@testing-library/react-native';
import { Keyboard } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { NameDialog } from './NameDialog';

function Host({ visible }: { visible: boolean }) {
  return (
    <PaperProvider>
      <NameDialog
        visible={visible}
        title="New folder"
        label="Folder name"
        onDismiss={jest.fn()}
        onSubmit={jest.fn()}
      />
    </PaperProvider>
  );
}

describe('NameDialog', () => {
  it('Create with the field focused puts the keyboard away (QA 2.6.1)', async () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);
    await render(<Host visible />);
    await fireEvent(screen.getByTestId('name-dialog-input'), 'focus');
    await fireEvent.press(screen.getByText('Create'));
    // The caller hides the dialog: the keyboard must not stay over what is under it.
    await screen.rerender(<Host visible={false} />);
    expect(dismiss).toHaveBeenCalled();
    dismiss.mockRestore();
  });
});
