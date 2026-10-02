/**
 * The camera around a trail selection (2.1.1): the ✕ glides back to the
 * pre-focus view, but leaving the focus by tapping the map elsewhere keeps
 * the camera exactly where it is.
 */
import type { LngLat } from '@core/models';
import { act, renderHook } from '@testing-library/react-native';

import { useSelectionCamera } from './useSelectionCamera';

const BEFORE = { center: [-71.2, 46.8] as LngLat, zoom: 12 };

function setup() {
  const setStop = jest.fn();
  const getViewState = jest.fn(async () => BEFORE);
  const cameraRef = { current: { setStop } };
  const mapRef = { current: { getViewState } };
  return { setStop, getViewState, cameraRef, mapRef };
}

async function focus(
  hook: { current: ReturnType<typeof useSelectionCamera> },
  canRead = true,
): Promise<jest.Mock> {
  const fit = jest.fn();
  await act(async () => {
    hook.current.fitAfterCapture(fit, canRead);
  });
  return fit;
}

it('the ✕ glides back to the view from before the focus, once', async () => {
  const { setStop, cameraRef, mapRef } = setup();
  const { result } = await renderHook(() => useSelectionCamera(cameraRef, mapRef));
  const fit = await focus(result);
  expect(fit).toHaveBeenCalledTimes(1);
  await act(async () => result.current.restore());
  expect(setStop).toHaveBeenCalledWith({ ...BEFORE, duration: 600 });
  await act(async () => result.current.restore());
  expect(setStop).toHaveBeenCalledTimes(1);
});

it('leaving the focus by a tap elsewhere keeps the camera where it is', async () => {
  const { setStop, cameraRef, mapRef } = setup();
  const { result } = await renderHook(() => useSelectionCamera(cameraRef, mapRef));
  await focus(result);
  await act(async () => result.current.forget());
  // Nothing moved, and a later ✕ (a new focus without a snapshot) has nothing stale to restore.
  expect(setStop).not.toHaveBeenCalled();
  await act(async () => result.current.restore());
  expect(setStop).not.toHaveBeenCalled();
});

it('switching trails keeps the first snapshot', async () => {
  const { setStop, getViewState, cameraRef, mapRef } = setup();
  const { result } = await renderHook(() => useSelectionCamera(cameraRef, mapRef));
  await focus(result);
  getViewState.mockResolvedValue({ center: [0, 0], zoom: 3 });
  await focus(result);
  expect(getViewState).toHaveBeenCalledTimes(1);
  await act(async () => result.current.restore());
  expect(setStop).toHaveBeenCalledWith({ ...BEFORE, duration: 600 });
});

it('never reads the camera before the map has loaded, but still fits', async () => {
  const { getViewState, cameraRef, mapRef } = setup();
  const { result } = await renderHook(() => useSelectionCamera(cameraRef, mapRef));
  const fit = await focus(result, false);
  expect(getViewState).not.toHaveBeenCalled();
  expect(fit).toHaveBeenCalledTimes(1);
});

it('keeps one identity across renders', async () => {
  const { cameraRef, mapRef } = setup();
  const { result, rerender } = await renderHook(() => useSelectionCamera(cameraRef, mapRef));
  const first = result.current;
  await rerender({});
  expect(result.current).toBe(first);
});
