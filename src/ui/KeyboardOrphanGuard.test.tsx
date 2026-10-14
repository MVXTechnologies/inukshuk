import { act, render } from '@testing-library/react-native';
import { Keyboard, Platform, TextInput } from 'react-native';

import { KeyboardOrphanGuard } from './KeyboardOrphanGuard';

/**
 * QA 2.6.1 — Explore › Add to Library › New folder… › Create: the name field
 * left with its dialog and the keyboard stayed up for a hidden WebView.
 */
describe('KeyboardOrphanGuard (Android)', () => {
  const os = Platform.OS;
  let listeners: Record<string, () => void>;
  let dismiss: jest.SpyInstance;
  beforeEach(() => {
    jest.useFakeTimers();
    Platform.OS = 'android';
    listeners = {};
    jest.spyOn(Keyboard, 'addListener').mockImplementation(((event: string, cb: () => void) => {
      listeners[event] = cb;
      return { remove: jest.fn() };
    }) as never);
    jest.spyOn(Keyboard, 'isVisible').mockReturnValue(false);
    dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined);
  });
  afterEach(() => {
    Platform.OS = os;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('keeps the keyboard while a field holds it; puts it away once none does', async () => {
    const field = jest.spyOn(TextInput.State, 'currentlyFocusedInput');
    field.mockReturnValue({} as never);
    await render(<KeyboardOrphanGuard />);
    await act(async () => listeners['keyboardDidShow']?.());
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(dismiss).not.toHaveBeenCalled();
    // The field left with its dialog: focus fell to a hidden WebView.
    field.mockReturnValue(null as never);
    await act(async () => {
      jest.advanceTimersByTime(250);
    });
    expect(dismiss).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(250);
    });
    expect(dismiss).toHaveBeenCalledTimes(1);
    // Stopped after: no repeated dismissals.
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('a field-to-field hop (one miss) never dismisses; no checks while hidden', async () => {
    const field = jest.spyOn(TextInput.State, 'currentlyFocusedInput');
    field.mockReturnValueOnce(null as never).mockReturnValue({} as never);
    await render(<KeyboardOrphanGuard />);
    await act(async () => listeners['keyboardDidShow']?.());
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });
    expect(dismiss).not.toHaveBeenCalled();
    await act(async () => listeners['keyboardDidHide']?.());
    field.mockReturnValue(null as never);
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });
    expect(dismiss).not.toHaveBeenCalled();
  });
});
