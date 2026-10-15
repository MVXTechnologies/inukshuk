import { act, renderHook } from '@testing-library/react-native';

import { useUndoSnackbar } from './useUndoSnackbar';

jest.useFakeTimers();

const action = (message: string) => ({ message, undo: jest.fn(), commit: jest.fn() });

describe('useUndoSnackbar', () => {
  it('commits once the time is up, and hides', async () => {
    const { result } = await renderHook(() => useUndoSnackbar(6000));
    const a = action('Deleted 2 items');
    await act(async () => result.current.show(a));
    expect(result.current.message).toBe('Deleted 2 items');
    await act(async () => {
      jest.advanceTimersByTime(5999);
    });
    expect(a.commit).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current.message).toBeNull();
    expect(a.commit).toHaveBeenCalledTimes(1);
    expect(a.undo).not.toHaveBeenCalled();
  });

  it('Undo undoes, hides, and never commits', async () => {
    const { result } = await renderHook(() => useUndoSnackbar(6000));
    const a = action('Moved');
    await act(async () => result.current.show(a));
    await act(async () => result.current.undo());
    expect(a.undo).toHaveBeenCalledTimes(1);
    expect(result.current.message).toBeNull();
    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    expect(a.commit).not.toHaveBeenCalled();
  });

  it('a new action commits the one before it; dismiss and unmount commit too', async () => {
    const { result, unmount } = await renderHook(() => useUndoSnackbar(6000));
    const a = action('first');
    const b = action('second');
    await act(async () => result.current.show(a));
    await act(async () => result.current.show(b));
    expect(a.commit).toHaveBeenCalledTimes(1);
    expect(result.current.message).toBe('second');
    await act(async () => result.current.dismiss());
    expect(b.commit).toHaveBeenCalledTimes(1);
    const c = action('third');
    await act(async () => result.current.show(c));
    await act(async () => unmount());
    expect(c.commit).toHaveBeenCalledTimes(1);
    // Nothing commits twice.
    expect(a.commit).toHaveBeenCalledTimes(1);
    expect(b.commit).toHaveBeenCalledTimes(1);
  });

  it('an action without a commit just goes', async () => {
    const { result } = await renderHook(() => useUndoSnackbar());
    await act(async () => result.current.show({ message: 'x', undo: jest.fn() }));
    await act(async () => {
      jest.advanceTimersByTime(6000);
    });
    expect(result.current.message).toBeNull();
  });
});
