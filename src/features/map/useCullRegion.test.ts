import { act, renderHook } from '@testing-library/react-native';

import { CULL_SETTLE_MS, useCullRegion, type SettledViewport } from './useCullRegion';

const view = (west: number): SettledViewport => ({
  west,
  south: 46.8,
  east: west + 0.02,
  north: 46.82,
});

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

it('is null until the map reports a viewport, then builds the first region at once', async () => {
  const { result, rerender } = await renderHook(
    ({ b, z }: { b: SettledViewport | null; z: number | null }) => useCullRegion(b, z),
    { initialProps: { b: null as SettledViewport | null, z: null as number | null } },
  );
  expect(result.current).toBeNull();
  await rerender({ b: view(-71.22), z: 14.3 });
  await advance(0);
  expect(result.current?.zoomLevel).toBe(14);
  expect(result.current?.bounds.minLng).toBeLessThan(-71.22);
});

it('keeps the region across settles inside it and moves after a debounced pan', async () => {
  const { result, rerender } = await renderHook(
    ({ b, z }: { b: SettledViewport; z: number }) => useCullRegion(b, z),
    { initialProps: { b: view(-71.22), z: 14.3 } },
  );
  await advance(0);
  const first = result.current;
  expect(first).not.toBeNull();

  // A GPS-follow nudge: a new bounds object, still inside the region.
  await rerender({ b: view(-71.219), z: 14.5 });
  await advance(CULL_SETTLE_MS);
  expect(result.current).toBe(first);

  // A pan out of the region: nothing until the camera has stayed put…
  await rerender({ b: view(-71.15), z: 14.5 });
  await advance(CULL_SETTLE_MS - 50);
  expect(result.current).toBe(first);
  // …a second settle restarts the wait; the last one wins.
  await rerender({ b: view(-71.1), z: 14.5 });
  await advance(CULL_SETTLE_MS - 50);
  expect(result.current).toBe(first);
  await advance(50);
  expect(result.current).not.toBe(first);
  expect(result.current?.bounds.minLng).toBeLessThan(-71.1);
  expect(result.current?.bounds.maxLng).toBeGreaterThan(-71.08);
});
