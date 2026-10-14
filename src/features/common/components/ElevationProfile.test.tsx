import { walk } from '@core/geo/track/__fixtures__/walk';
import type { TrackPointAt } from '@core/geo/track';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useState } from 'react';
import type { GestureResponderEvent } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { ElevationProfile } from './ElevationProfile';

/**
 * The profile's PanResponder is rebuilt whenever `onScrub` changes identity,
 * and a host that keeps the scrub in state passes a fresh arrow on every
 * frame. React Native dispatches each touch to the responder's CURRENT props,
 * and the scrub reads only `locationX` (no accumulated gestureState), so a
 * rebuild mid-drag must lose nothing. Pinned here so a later change to the
 * responder (e.g. reading gestureState.dx) can't silently break it.
 */

const POINTS = walk([
  { m: 1000, s: 600, rise: 100 },
  { m: 1000, s: 600, rise: -60 },
]);
const WIDTH = 300;

function touch(locationX: number, t: number, prevX: number) {
  const tc = { identifier: 0, locationX, locationY: 60, pageX: locationX, pageY: 60, timestamp: t };
  return {
    nativeEvent: { ...tc, touches: [tc], changedTouches: [tc] },
    touchHistory: {
      numberActiveTouches: 1,
      indexOfSingleActiveTouch: 0,
      mostRecentTimeStamp: t,
      touchBank: [
        {
          touchActive: true,
          startPageX: 40,
          startPageY: 60,
          startTimeStamp: 1,
          currentPageX: locationX,
          currentPageY: 60,
          currentTimeStamp: t,
          previousPageX: prevX,
          previousPageY: 60,
          previousTimeStamp: t - 1,
        },
      ],
    },
  } as unknown as GestureResponderEvent;
}

it('keeps scrubbing through every move while the host re-renders with a fresh onScrub', async () => {
  const seen: (number | null)[] = [];
  function Host() {
    const [at, setAt] = useState<TrackPointAt | null>(null);
    return (
      <ElevationProfile
        points={POINTS}
        ascentM={100}
        descentM={60}
        onScrub={(next) => {
          seen.push(next === null ? null : Math.round(next.distanceM));
          setAt(next);
        }}
        selectedDistanceM={at?.distanceM ?? null}
      />
    );
  }
  await render(
    <PaperProvider>
      <Host />
    </PaperProvider>,
  );
  const chart = () => screen.getByTestId('elevation-profile-chart');
  await act(async () =>
    fireEvent(chart(), 'layout', { nativeEvent: { layout: { width: WIDTH, height: 170 } } }),
  );

  const xs = [40, 80, 120, 160, 200, 240, 200, 120];
  await fireEvent(chart(), 'responderGrant', touch(xs[0]!, 2, xs[0]!));
  for (let i = 1; i < xs.length; i++) {
    // Each move lands after the host committed the previous one's render.
    await fireEvent(chart(), 'responderMove', touch(xs[i]!, 2 + i, xs[i - 1]!));
  }
  const moved = seen.filter((d): d is number => d !== null);
  expect(moved).toHaveLength(xs.length);
  // Out, then back: the scrub followed the finger both ways.
  expect(moved.slice(0, 6)).toEqual([...moved.slice(0, 6)].sort((a, b) => a - b));
  expect(moved[5]!).toBeGreaterThan(moved[0]!);
  expect(moved[7]!).toBeLessThan(moved[5]!);
  expect(screen.queryByText('Touch the graph to read elevation')).toBeNull();

  await fireEvent(chart(), 'responderRelease', touch(120, 20, 120));
  expect(seen[seen.length - 1]).toBeNull();
  expect(screen.getByText('Touch the graph to read elevation')).toBeTruthy();
});
