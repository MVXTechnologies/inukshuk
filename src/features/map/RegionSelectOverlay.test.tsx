import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';
import { RegionSelectOverlay } from './RegionSelectOverlay';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

async function show(
  toGeo: (p: { x: number; y: number }) => [number, number] | null,
  refreshBounds: jest.Mock,
) {
  await render(
    <PaperProvider>
      <RegionSelectOverlay
        toGeo={toGeo}
        boundsVersion={0}
        refreshBounds={refreshBounds}
        activeBasemap="map"
        tileUrl="https://tiles/{z}/{x}/{y}.png"
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
      />
    </PaperProvider>,
  );
  await fireEvent(screen.getByTestId('region-select-overlay'), 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 800 } },
  });
}

it('keeps re-reading the bounds while no estimate has landed (the map was idle)', async () => {
  const refreshBounds = jest.fn(async () => undefined);
  await show(() => null, refreshBounds);
  expect(screen.getByText('Calculating…')).toBeTruthy();
  await act(async () => {
    jest.advanceTimersByTime(3000);
  });
  expect(refreshBounds.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(screen.getByText('Calculating…')).toBeTruthy();
});

it('stops retrying once the bounds convert', async () => {
  const refreshBounds = jest.fn(async () => undefined);
  let ready = false;
  const toGeo = (p: { x: number; y: number }): [number, number] | null =>
    ready ? [-71 + p.x / 1e4, 46 - p.y / 1e4] : null;
  await show(toGeo, refreshBounds);
  ready = true;
  await act(async () => {
    jest.advanceTimersByTime(3000);
  });
  expect(screen.queryByText('Calculating…')).toBeNull();
  const calls = refreshBounds.mock.calls.length;
  await act(async () => {
    jest.advanceTimersByTime(3000);
  });
  expect(refreshBounds.mock.calls.length).toBe(calls);
});
