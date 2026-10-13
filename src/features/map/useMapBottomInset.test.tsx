/**
 * #682: a sheet docked at the Map's bottom edge pads by the system inset only
 * while the tab bar is hidden there (recording, moving a waypoint); otherwise
 * the tab bar already absorbs it.
 */
import { useRecorderStore } from '@state/recorderStore';
import { useWaypointMoveStore } from '@state/waypointMoveStore';
import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useMapBottomInset } from './useMapBottomInset';

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 800 },
  insets: { top: 24, left: 0, right: 0, bottom: 48 },
};

function wrapper({ children }: { children: ReactNode }) {
  return <SafeAreaProvider initialMetrics={METRICS}>{children}</SafeAreaProvider>;
}

afterEach(async () => {
  await act(async () => {
    useRecorderStore.setState({ status: 'idle' });
    useWaypointMoveStore.getState().end();
  });
});

it('is 0 while the tab bar is up (it absorbs the inset)', async () => {
  const { result } = await renderHook(() => useMapBottomInset(), { wrapper });
  expect(result.current).toBe(0);
});

it('is the system inset while recording (tab bar hidden on the Map)', async () => {
  const { result } = await renderHook(() => useMapBottomInset(), { wrapper });
  await act(async () => useRecorderStore.setState({ status: 'recording' }));
  expect(result.current).toBe(48);
  await act(async () => useRecorderStore.setState({ status: 'paused' }));
  expect(result.current).toBe(48);
});

it('is the system inset while moving a waypoint', async () => {
  const { result } = await renderHook(() => useMapBottomInset(), { wrapper });
  await act(async () =>
    useWaypointMoveStore.getState().start({
      id: 'w1',
      label: 'Camp',
      from: { latitude: 46.8, longitude: -71.2 },
    }),
  );
  expect(result.current).toBe(48);
});
