/**
 * #682: the system navigation bar is hidden by default and kept visible when
 * Settings › Display asks for it; either choice is re-applied on resume (the
 * OS can move the bar while we are away). iOS has no such bar.
 */
import { renderHook } from '@testing-library/react-native';
import { AppState, Platform, type AppStateStatus } from 'react-native';

import { useAndroidImmersive } from './useAndroidImmersive';

jest.mock('expo-navigation-bar', () => ({
  setVisibilityAsync: jest.fn(async () => undefined),
}));

const nav = jest.requireMock('expo-navigation-bar') as { setVisibilityAsync: jest.Mock };

let listeners: ((state: AppStateStatus) => void)[] = [];
const remove = jest.fn();

beforeEach(() => {
  nav.setVisibilityAsync.mockClear();
  nav.setVisibilityAsync.mockImplementation(async () => undefined);
  remove.mockClear();
  listeners = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, fn) => {
    listeners.push(fn as (state: AppStateStatus) => void);
    return { remove } as never;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

function onOs(os: 'android' | 'ios') {
  jest.replaceProperty(Platform, 'OS', os);
}

function emit(state: AppStateStatus) {
  for (const fn of listeners) fn(state);
}

describe('on Android', () => {
  beforeEach(() => onOs('android'));

  it('hides the bar by default, once', async () => {
    await renderHook(() => useAndroidImmersive(false));
    expect(nav.setVisibilityAsync.mock.calls).toEqual([['hidden']]);
  });

  it('shows the bar when the setting is on', async () => {
    await renderHook(() => useAndroidImmersive(true));
    expect(nav.setVisibilityAsync.mock.calls).toEqual([['visible']]);
  });

  it('re-applies the choice on every return to the foreground, and only then', async () => {
    await renderHook(() => useAndroidImmersive(true));
    nav.setVisibilityAsync.mockClear();
    emit('background');
    emit('inactive');
    expect(nav.setVisibilityAsync).not.toHaveBeenCalled();
    emit('active');
    emit('background');
    emit('active');
    expect(nav.setVisibilityAsync.mock.calls).toEqual([['visible'], ['visible']]);
  });

  it('re-applies "hidden" on resume when the setting is off', async () => {
    await renderHook(() => useAndroidImmersive(false));
    nav.setVisibilityAsync.mockClear();
    emit('active');
    expect(nav.setVisibilityAsync.mock.calls).toEqual([['hidden']]);
  });

  it('follows a toggle: applies the new value at once and on resume, with one listener', async () => {
    const hook = await renderHook(({ show }: { show: boolean }) => useAndroidImmersive(show), {
      initialProps: { show: false },
    });
    await hook.rerender({ show: true });
    expect(nav.setVisibilityAsync.mock.calls).toEqual([['hidden'], ['visible']]);
    // The old listener was removed; the live one carries the new value.
    expect(remove).toHaveBeenCalledTimes(1);
    nav.setVisibilityAsync.mockClear();
    listeners.at(-1)?.('active');
    expect(nav.setVisibilityAsync.mock.calls).toEqual([['visible']]);

    await hook.rerender({ show: false });
    expect(nav.setVisibilityAsync.mock.calls).toEqual([['visible'], ['hidden']]);
  });

  it('does not re-apply on a re-render with the same value', async () => {
    const hook = await renderHook(({ show }: { show: boolean }) => useAndroidImmersive(show), {
      initialProps: { show: true },
    });
    await hook.rerender({ show: true });
    expect(nav.setVisibilityAsync).toHaveBeenCalledTimes(1);
  });

  it('removes the listener on unmount', async () => {
    const hook = await renderHook(() => useAndroidImmersive(false));
    await hook.unmount();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('swallows a native failure, sync or async', async () => {
    nav.setVisibilityAsync.mockImplementationOnce(() => {
      throw new Error('no activity');
    });
    await expect(renderHook(() => useAndroidImmersive(true))).resolves.toBeDefined();
    nav.setVisibilityAsync.mockImplementationOnce(async () => {
      throw new Error('no activity');
    });
    expect(() => emit('active')).not.toThrow();
    // Let the rejected promise settle: an unhandled rejection would fail the run.
    await Promise.resolve();
  });
});

describe('on iOS', () => {
  beforeEach(() => onOs('ios'));

  it('is a no-op whatever the setting', async () => {
    await renderHook(() => useAndroidImmersive(true));
    await renderHook(() => useAndroidImmersive(false));
    expect(nav.setVisibilityAsync).not.toHaveBeenCalled();
    expect(AppState.addEventListener).not.toHaveBeenCalled();
  });
});
