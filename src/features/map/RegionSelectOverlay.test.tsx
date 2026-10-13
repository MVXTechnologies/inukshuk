import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useRecorderStore } from '@state/recorderStore';
import { StyleSheet } from 'react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';
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

describe('the sheet clears the system navigation bar (#682)', () => {
  const METRICS = {
    frame: { x: 0, y: 0, width: 390, height: 800 },
    insets: { top: 24, left: 0, right: 0, bottom: 48 },
  };

  async function sheetPadding(): Promise<unknown> {
    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <PaperProvider>
          <RegionSelectOverlay
            toGeo={() => null}
            boundsVersion={0}
            refreshBounds={jest.fn(async () => undefined)}
            activeBasemap="map"
            tileUrl="https://tiles/{z}/{x}/{y}.png"
            onConfirm={jest.fn()}
            onCancel={jest.fn()}
          />
        </PaperProvider>
      </SafeAreaProvider>,
    );
    return StyleSheet.flatten(screen.getByTestId('region-select-sheet').props.style).paddingBottom;
  }

  afterEach(async () => {
    await act(async () => useRecorderStore.setState({ status: 'idle' }));
  });

  it('pads only its own 14 dp above the tab bar (which absorbs the inset)', async () => {
    expect(await sheetPadding()).toBe(14);
  });

  it('adds the inset while recording, when the tab bar is hidden on the Map', async () => {
    useRecorderStore.setState({ status: 'recording' });
    expect(await sheetPadding()).toBe(14 + 48);
  });
});
