import { fireEvent, render, screen } from '@testing-library/react-native';
import { Keyboard, TextInput } from 'react-native';

import { useKeyboardRelease } from './useKeyboardRelease';

function Field({ open = true }: { open?: boolean }) {
  const release = useKeyboardRelease(open);
  return <TextInput testID="field" returnKeyType="done" {...release} />;
}

describe('useKeyboardRelease (QA 2.6.1: the orphaned keyboard)', () => {
  let dismiss: jest.SpyInstance;
  beforeEach(() => {
    dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);
  });
  afterEach(() => dismiss.mockRestore());

  it('a focused field leaving with its host puts the keyboard away', async () => {
    await render(<Field />);
    await fireEvent(screen.getByTestId('field'), 'focus');
    await screen.unmount();
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('a field that was not focused (or was left first) leaves the keyboard alone', async () => {
    await render(<Field />);
    await fireEvent(screen.getByTestId('field'), 'focus');
    await fireEvent(screen.getByTestId('field'), 'blur');
    await screen.unmount();
    await render(<Field />);
    await screen.unmount();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('a host that stays mounted (a dialog) releases it when it hides', async () => {
    await render(<Field open />);
    await fireEvent(screen.getByTestId('field'), 'focus');
    await screen.rerender(<Field open={false} />);
    expect(dismiss).toHaveBeenCalledTimes(1);
    await screen.unmount();
    expect(dismiss).toHaveBeenCalledTimes(1);
  });
});
