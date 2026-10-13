import { act, fireEvent, render, renderHook, screen } from '@testing-library/react-native';
import { darkTheme, lightTheme } from '@ui/theme';
import { StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { ActionSnackbar } from './ActionSnackbar';
import { useActionSnackbar, type ActionSnack } from './useActionSnackbar';

describe('useActionSnackbar', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('dismisses itself on its own timer, not on an animation callback', async () => {
    const { result } = await renderHook(() => useActionSnackbar(8000));
    await act(async () => result.current.show('Waypoint 7 added at your position'));
    expect(result.current.current?.message).toBe('Waypoint 7 added at your position');
    await act(async () => jest.advanceTimersByTime(7999));
    expect(result.current.current).not.toBeNull();
    await act(async () => jest.advanceTimersByTime(1));
    expect(result.current.current).toBeNull();
  });

  it('restarts the timer when a new message replaces the old', async () => {
    const { result } = await renderHook(() => useActionSnackbar(1000));
    await act(async () => result.current.show('one'));
    await act(async () => jest.advanceTimersByTime(800));
    await act(async () => result.current.show('two'));
    await act(async () => jest.advanceTimersByTime(800));
    expect(result.current.current?.message).toBe('two');
    await act(async () => jest.advanceTimersByTime(200));
    expect(result.current.current).toBeNull();
  });

  it('an action dismisses first, then runs once', async () => {
    const undo = jest.fn();
    const { result } = await renderHook(() => useActionSnackbar(1000));
    await act(async () => result.current.show('Moved 38 m', [{ label: 'Undo', onPress: undo }]));
    await act(async () => result.current.current?.actions[0]?.onPress());
    expect(undo).toHaveBeenCalledTimes(1);
    expect(result.current.current).toBeNull();
  });
});

describe('ActionSnackbar', () => {
  const snack: ActionSnack = {
    message: 'Waypoint 7 added at your position',
    actions: [
      { label: 'Edit', onPress: jest.fn() },
      { label: 'Undo', onPress: jest.fn() },
    ],
    seq: 1,
  };

  it('renders nothing when there is no snack', async () => {
    await render(
      <PaperProvider>
        <ActionSnackbar snack={null} />
      </PaperProvider>,
    );
    expect(screen.queryByTestId('action-snackbar')).toBeNull();
  });

  it('shows the message and its actions, upper-cased, as buttons', async () => {
    await render(
      <PaperProvider>
        <ActionSnackbar snack={snack} />
      </PaperProvider>,
    );
    expect(screen.getByText('Waypoint 7 added at your position')).toBeOnTheScreen();
    expect(screen.getByText('EDIT')).toBeOnTheScreen();
    await fireEvent.press(screen.getByLabelText('Undo'));
    expect(snack.actions[1]?.onPress).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['light', lightTheme],
    ['dark', darkTheme],
  ])('uses the %s theme’s inverse surface', async (_n, theme) => {
    await render(
      <PaperProvider theme={theme}>
        <ActionSnackbar snack={snack} />
      </PaperProvider>,
    );
    const bar = StyleSheet.flatten(screen.getByTestId('action-snackbar').props.style) as {
      backgroundColor?: string;
    };
    expect(bar.backgroundColor).toBe(theme.colors.inverseSurface);
  });
});
