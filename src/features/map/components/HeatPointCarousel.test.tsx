import type { TrackStats, TrackSummary } from '@core/models';
import { act, render, screen } from '@testing-library/react-native';
import type { GestureResponderEvent } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { HeatPointCarousel } from './HeatPointCarousel';

/**
 * A swipe on the activity deck must survive the map re-rendering under it.
 * MapScreen passes a fresh `onFocus` arrow on every render (every GPS tick);
 * the deck used to rebuild its PanResponder then, and the new responder's
 * gestureState restarted from dy = 0 mid-swipe: the stack snapped back and a
 * full-length swipe released as a short one, so it didn't commit.
 */

const STATS = { distanceM: 5000, durationS: 3600 } as TrackStats;
const track = (id: string, startedAt: number): TrackSummary => ({
  id,
  name: `Run ${id}`,
  startedAt,
  stats: STATS,
  fileUri: `file:///${id}.gpx`,
});
const TRACKS = [track('a', 3), track('b', 2), track('c', 1)];

/** A one-finger touch history at `pageY`, as the responder system builds it. */
function touchEvent(pageY: number, t: number, prevY: number) {
  const touch = { identifier: 0, pageX: 100, pageY, locationX: 50, locationY: 40, timestamp: t };
  return {
    nativeEvent: { ...touch, touches: [touch], changedTouches: [touch] },
    touchHistory: {
      numberActiveTouches: 1,
      indexOfSingleActiveTouch: 0,
      mostRecentTimeStamp: t,
      touchBank: [
        {
          touchActive: true,
          startPageX: 100,
          startPageY: 200,
          startTimeStamp: 0,
          currentPageX: 100,
          currentPageY: pageY,
          currentTimeStamp: t,
          previousPageX: 100,
          previousPageY: prevY,
          previousTimeStamp: t - 1,
        },
      ],
    },
  } as unknown as GestureResponderEvent;
}

it('commits a full swipe even when the host re-renders mid-swipe with a fresh onFocus', async () => {
  const focused: number[] = [];
  // A fresh onFocus per render, like MapScreen's inline arrow.
  const deck = () => (
    <PaperProvider>
      <HeatPointCarousel
        trackIds={['a', 'b', 'c']}
        tracks={TRACKS}
        focusedIdx={0}
        onFocus={(idx) => focused.push(idx)}
        onOpenTrail={jest.fn()}
        onClose={jest.fn()}
        topInset={0}
      />
    </PaperProvider>
  );
  const view = await render(deck());
  // The deck claims the touch only once it has moved, which fireEvent's
  // enabled-check can't see: dispatch to its responder props directly, as the
  // responder system does after the claim.
  type Phase = 'onResponderGrant' | 'onResponderMove' | 'onResponderRelease';
  const send = (phase: Phase, e: GestureResponderEvent) =>
    act(async () => {
      const handler = screen.getByTestId('heat-deck').props[phase] as
        ((ev: GestureResponderEvent) => void) | undefined;
      handler?.(e);
    });

  // The finger lands at y = 200 and swipes up 15 dp...
  await send('onResponderGrant', touchEvent(200, 1, 200));
  await send('onResponderMove', touchEvent(185, 2, 200));
  // ...a GPS tick re-renders the map (a new onFocus)...
  await view.rerender(deck());
  // ...and the swipe goes on to 30 dp up: past the 24 dp commit step.
  await send('onResponderMove', touchEvent(170, 3, 185));
  await send('onResponderRelease', touchEvent(170, 4, 170));

  expect(focused).toEqual([1]);
});
