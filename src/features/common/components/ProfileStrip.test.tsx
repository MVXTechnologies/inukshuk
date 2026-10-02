/**
 * The drawing tool's elevation strip (#515): its chart, the dimmed "updating"
 * state, and scrubbing — a finger on the strip reports the point under it
 * (for the map marker) and shows distance · elevation · grade; lifting clears.
 */
import { buildDrawProfile } from '@core/draw/profile';
import type { LngLat } from '@core/models';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';

import { formatGrade, ProfileStrip } from './ProfileStrip';

// ~1.1 km north, climbing 10 m every 111 m (≈ 9 %).
const N = 11;
const LINE: LngLat[] = Array.from({ length: N }, (_, i) => [-70.9, 47 + i * 0.001]);
const ELEV = LINE.map((_, i) => 200 + i * 10);
const PROFILE = buildDrawProfile(LINE, ELEV)!;

/** A responder event at `x` px (PanResponder reads the touch history too). */
const touch = (x: number) => ({
  nativeEvent: { locationX: x, locationY: 10, pageX: x, pageY: 10, touches: [], timestamp: 1 },
  touchHistory: {
    numberActiveTouches: 1,
    indexOfSingleActiveTouch: 0,
    mostRecentTimeStamp: 1,
    touchBank: [
      {
        touchActive: true,
        startPageX: x,
        startPageY: 10,
        startTimeStamp: 1,
        currentPageX: x,
        currentPageY: 10,
        currentTimeStamp: 1,
        previousPageX: x,
        previousPageY: 10,
        previousTimeStamp: 1,
      },
    ],
  },
});

async function mount(props: Partial<Parameters<typeof ProfileStrip>[0]> = {}) {
  const onScrub = jest.fn();
  await render(
    <PaperProvider>
      <ProfileStrip profile={PROFILE} units="metric" onScrub={onScrub} {...props} />
    </PaperProvider>,
  );
  const strip = screen.getByTestId('route-profile');
  await act(async () => {
    fireEvent(strip, 'layout', { nativeEvent: { layout: { width: 300, height: 68 } } });
  });
  return { strip, onScrub };
}

describe('ProfileStrip', () => {
  it('charts the N samples, labels min and max, and says so to a screen reader', async () => {
    expect(PROFILE.points).toHaveLength(N);
    await mount();
    expect(screen.getByText('300 m')).toBeOnTheScreen();
    expect(screen.getByText('200 m')).toBeOnTheScreen();
    expect(screen.getByLabelText(/^Elevation profile, 1\.1 km, 200 m to 300 m$/)).toBeOnTheScreen();
  });

  it('dims while newer elevation is on the way', async () => {
    const { strip } = await mount({ dimmed: true });
    expect(strip).toHaveStyle({ opacity: 0.45 });
    expect(screen.getByLabelText(/, updating$/)).toBeOnTheScreen();
  });

  it('scrubbing reports the point under the finger and shows its readout; release clears', async () => {
    const { strip, onScrub } = await mount();
    await act(async () => {
      fireEvent(strip, 'responderGrant', touch(150));
    });
    const mid = onScrub.mock.calls.at(-1)?.[0] as { at: LngLat; distanceM: number } | null;
    expect(mid?.at[1]).toBeCloseTo(47.005, 5);
    expect(screen.getByTestId('route-profile-readout')).toHaveTextContent('556 m · 250 m · +9 %');

    await act(async () => {
      fireEvent(strip, 'responderMove', touch(300));
    });
    const end = onScrub.mock.calls.at(-1)?.[0] as { at: LngLat } | null;
    expect(end?.at).toEqual(LINE[N - 1]);
    expect(screen.getByTestId('route-profile-readout')).toHaveTextContent(/^1\.1 km · 300 m/);

    await act(async () => {
      fireEvent(strip, 'responderRelease', touch(300));
    });
    expect(onScrub).toHaveBeenLastCalledWith(null);
    expect(screen.queryByTestId('route-profile-readout')).toBeNull();
  });

  it('formats grades with a sign', () => {
    expect(formatGrade(12.4)).toBe('+12 %');
    expect(formatGrade(-3.6)).toBe('−4 %');
    expect(formatGrade(0.2)).toBe('0 %');
  });
});
