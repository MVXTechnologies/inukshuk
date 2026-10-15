import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useState } from 'react';
import { State, type PanGesture } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';
import { PaperProvider } from 'react-native-paper';

import { SCRUB_ACTIVATE_X, SCRUB_FAIL_Y, TrailChart } from './TrailChart';

/**
 * Owner report (2.6.1): "when dragging the elevation profile, it often stops
 * moving, like it gets out of the drag mode". The chart's PanResponder let the
 * page ScrollView take the touch; on Android the native ScrollView intercepts
 * after ~8 dp of vertical drift from touch-down, whatever the sideways travel,
 * and the cursor froze. The scrub is now a direction-locked gesture-handler
 * Pan: these tests pin the lock and that a drag reports every position to the
 * CURRENT handler while the host re-renders under it on each frame.
 */

const DISTANCES = Array.from({ length: 101 }, (_, i) => i * 10); // 0..1000 m
const VALUES = DISTANCES.map((d) => 100 + d / 10);
const WIDTH = 200;

/** The trail view's shape: the cursor lives in the host, set on every frame. */
function Host({ calls }: { calls: { gen: number; distanceM: number }[] }) {
  const [cursor, setCursor] = useState<number | null>(null);
  const gen = cursor === null ? 0 : calls.length;
  return (
    <TrailChart
      title="Elevation"
      valueText={cursor === null ? 'drag to explore' : `${Math.round(cursor)} m`}
      distances={DISTANCES}
      totalM={1000}
      values={VALUES}
      color="#c80"
      area
      cursorDistanceM={cursor}
      // A fresh closure every render: each frame must reach the newest one.
      onScrub={(distanceM) => {
        calls.push({ gen, distanceM });
        setCursor(distanceM);
      }}
      testID="chart-elevation"
    />
  );
}

async function mount() {
  const calls: { gen: number; distanceM: number }[] = [];
  await render(
    <PaperProvider>
      <Host calls={calls} />
    </PaperProvider>,
  );
  await act(async () =>
    fireEvent(screen.getByLabelText('Elevation chart'), 'layout', {
      nativeEvent: { layout: { width: WIDTH, height: 80 } },
    }),
  );
  return calls;
}

describe('TrailChart scrub', () => {
  it('locks the drag to one axis natively: sideways scrubs, vertical scrolls the page', async () => {
    await mount();
    const { config } = getByGestureTestId('chart-elevation-scrub') as PanGesture;
    expect(config).toMatchObject({
      activeOffsetXStart: -SCRUB_ACTIVATE_X,
      activeOffsetXEnd: SCRUB_ACTIVATE_X,
      failOffsetYStart: -SCRUB_FAIL_Y,
      failOffsetYEnd: SCRUB_FAIL_Y,
    });
    // A drag at least twice as tall as it is wide is the page's.
    expect(SCRUB_FAIL_Y).toBe(2 * SCRUB_ACTIVATE_X);
  });

  it('follows the finger through a long back-and-forth drag, vertical wobble and all', async () => {
    const calls = await mount();
    // Out to the far end, back past the start (net dx ~ 0: the old hand-over
    // test yielded here) and out again, wobbling 30 dp up and down.
    const xs = [20, 60, 100, 150, 199, 150, 100, 40, 10, -30, 50, 120, 180];
    await act(async () =>
      fireGestureHandler(getByGestureTestId('chart-elevation-scrub'), [
        { state: State.BEGAN, x: 20, y: 40 },
        ...xs.slice(1).map((x, i) => ({ state: State.ACTIVE, x, y: 40 + (i % 2 ? 30 : -30) })),
        { state: State.END, x: 180, y: 40 },
      ]),
    );
    const expected = xs.map((x) => (Math.min(WIDTH, Math.max(0, x)) / WIDTH) * 1000);
    expect(calls.map((c) => c.distanceM)).toEqual(expected);
    expect(screen.getByText('900 m')).toBeTruthy();
  });

  it('reaches the newest handler on every frame while the host re-renders under the drag', async () => {
    const calls = await mount();
    // The detector's live callbacks, as the native handler dispatches them.
    const handlers = () => (getByGestureTestId('chart-elevation-scrub') as PanGesture).handlers;
    type Down = Parameters<NonNullable<ReturnType<typeof handlers>['onBegin']>>[0];
    type Frame = Parameters<NonNullable<ReturnType<typeof handlers>['onUpdate']>>[0];
    // One act per frame: the host commits a render (and a fresh onScrub)
    // between frames, as it does on device.
    await act(async () => handlers().onBegin?.({ x: 10, y: 40 } as Down));
    for (const x of [30, 60, 90, 120, 150]) {
      await act(async () => handlers().onUpdate?.({ x, y: 40 } as Frame));
    }
    expect(calls).toEqual(
      [10, 30, 60, 90, 120, 150].map((x, i) => ({ gen: i, distanceM: (x / WIDTH) * 1000 })),
    );
    expect(screen.getByText('750 m')).toBeTruthy();
  });

  it('places the cursor on touch-down, before the drag direction is known', async () => {
    // A tap, a press held still, or the start of a page scroll: the Pan only
    // BEGINs (it fails once the finger travels SCRUB_FAIL_Y vertically).
    const calls = await mount();
    const { handlers } = getByGestureTestId('chart-elevation-scrub') as PanGesture;
    type Down = Parameters<NonNullable<typeof handlers.onBegin>>[0];
    await act(async () => handlers.onBegin?.({ x: 50, y: 10 } as Down));
    expect(calls.map((c) => c.distanceM)).toEqual([250]);
  });
});
