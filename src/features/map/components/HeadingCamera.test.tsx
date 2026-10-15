/**
 * "Rotate map with compass": the camera bearing follows the display-rate
 * heading, one jump per frame, re-rendering the camera only — and never
 * while MapLibre follows you, because on Android any camera move from the
 * app ends the follow (2.6.1 QA: Locate dropped to idle after one heading
 * step in heading-up). The mock camera below does what MapLibre Android does.
 */
import { act, render } from '@testing-library/react-native';
import { Profiler, useState } from 'react';
import type { NativeSyntheticEvent } from 'react-native';
import { HeadingCamera } from './HeadingCamera';

type Props = Record<string, unknown>;
const mockCameraProps: Props[] = [];
/** Native camera moves the mock applied (a changed stop is one, as on Android). */
const mockNative = { moves: 0, tracking: null as string | null };

jest.mock('@maplibre/maplibre-react-native', () => {
  const mockReact = jest.requireActual<typeof import('react')>('react');
  /**
   * MapLibre Android, as maplibre-react-native drives it: a changed `stop`
   * (bearing, duration…) is applied with `MapLibreMap.moveCamera`, which
   * notifies the location component's developer-animation listener —
   * `setCameraMode(NONE)` — and the follow ends: `onTrackUserLocationChange`
   * with null.
   */
  function Camera(props: Props) {
    mockCameraProps.push(props);
    const { trackUserLocation, onTrackUserLocationChange, bearing, duration } = props as {
      trackUserLocation?: string;
      onTrackUserLocationChange?: (e: {
        nativeEvent: { trackUserLocation: string | null };
      }) => void;
      bearing?: number;
      duration?: number;
    };
    const stopKey = JSON.stringify({ bearing, duration });
    const prevStop = mockReact.useRef<string | null>(null);
    mockReact.useEffect(() => {
      mockNative.tracking = trackUserLocation ?? null;
    }, [trackUserLocation]);
    mockReact.useEffect(() => {
      const changed = prevStop.current !== null && prevStop.current !== stopKey;
      prevStop.current = stopKey;
      if (!changed) return;
      mockNative.moves++;
      if (mockNative.tracking !== null) {
        mockNative.tracking = null;
        onTrackUserLocationChange?.({ nativeEvent: { trackUserLocation: null } });
      }
    }, [stopKey, onTrackUserLocationChange]);
    return null;
  }
  return { Camera };
});

type Frame = { headingDeg: number; moving: boolean };
const mockListeners = new Set<(f: Frame) => void>();
jest.mock('../headingMotion', () => ({
  subscribeHeadingMotion: (l: (f: Frame) => void) => {
    mockListeners.add(l);
    return () => mockListeners.delete(l);
  },
}));

async function heading(deg: number, moving = true) {
  await act(async () => {
    for (const l of mockListeners) l({ headingDeg: deg, moving });
  });
}

beforeEach(() => {
  mockCameraProps.length = 0;
  mockListeners.clear();
  mockNative.moves = 0;
  mockNative.tracking = null;
});

/** MapScreen's follow wiring: Locate on until the native follow reports it ended. */
function FollowingScreen({
  headingUp,
  onFollow,
}: {
  headingUp: boolean;
  onFollow: (f: boolean) => void;
}) {
  const [follow, setFollow] = useState(true);
  onFollow(follow);
  return (
    <HeadingCamera
      followHeading={headingUp}
      trackUserLocation={follow ? 'default' : undefined}
      onTrackUserLocationChange={(
        e: NativeSyntheticEvent<{ trackUserLocation: string | null }>,
      ) => {
        if (e.nativeEvent.trackUserLocation === null) setFollow(false);
      }}
    />
  );
}

describe('HeadingCamera', () => {
  it('off: a plain camera, no bearing, and no heading subscription', async () => {
    await render(<HeadingCamera followHeading={false} minZoom={0} trackUserLocation="default" />);
    expect(mockListeners.size).toBe(0);
    const last = mockCameraProps.at(-1)!;
    expect(last.minZoom).toBe(0);
    expect(last.trackUserLocation).toBe('default');
    expect('bearing' in last).toBe(false);
  });

  it('not following: every heading frame is one camera bearing, applied without a transition', async () => {
    await render(<HeadingCamera followHeading />);
    for (let i = 1; i <= 30; i++) await heading(100 + i * 1.5);
    const bearings = mockCameraProps.filter((p) => 'bearing' in p);
    expect(bearings).toHaveLength(30);
    for (const p of bearings) {
      expect(p.duration).toBe(0);
      expect(p.trackUserLocation).toBeUndefined();
    }
    expect(bearings.at(-1)?.bearing).toBe(145);
  });

  it('following: hands the bearing to the native compass follow, sends none itself', async () => {
    await render(<HeadingCamera followHeading trackUserLocation="default" />);
    expect(mockListeners.size).toBe(0);
    expect(mockCameraProps.at(-1)?.trackUserLocation).toBe('heading');
    expect('bearing' in mockCameraProps.at(-1)!).toBe(false);
  });

  it('REGRESSION (2.6.1 QA): heading-up keeps Locate following through 8 heading steps', async () => {
    let follow = true;
    await render(<FollowingScreen headingUp onFollow={(f) => (follow = f)} />);
    for (let i = 1; i <= 8; i++) {
      await heading(100 + i * 2, false);
      expect(follow).toBe(true);
    }
    expect(mockNative.moves).toBe(0);
    expect(mockNative.tracking).toBe('heading');
  });

  it('north-up keeps following too (the control case)', async () => {
    let follow = true;
    await render(<FollowingScreen headingUp={false} onFollow={(f) => (follow = f)} />);
    for (let i = 1; i <= 8; i++) await heading(100 + i * 2, false);
    expect(follow).toBe(true);
    expect(mockNative.tracking).toBe('default');
  });

  it('starting to follow after turning the map from JS sends no camera move (the stop stays put)', async () => {
    const view = await render(<HeadingCamera followHeading />);
    await heading(42);
    expect(mockCameraProps.at(-1)?.bearing).toBe(42);
    const moves = mockNative.moves;
    await view.rerender(<HeadingCamera followHeading trackUserLocation="default" />);
    expect(mockListeners.size).toBe(0);
    const last = mockCameraProps.at(-1)!;
    expect(last.trackUserLocation).toBe('heading');
    // Same stop as before: no native camera move, so nothing to end the follow.
    expect(last.bearing).toBe(42);
    expect(mockNative.moves).toBe(moves);
  });

  it('turning heading-up off leaves the bearing where it is and stops listening', async () => {
    const view = await render(<HeadingCamera followHeading />);
    await heading(42);
    const moves = mockNative.moves;
    await view.rerender(<HeadingCamera followHeading={false} />);
    expect(mockListeners.size).toBe(0);
    expect(mockCameraProps.at(-1)?.bearing).toBe(42);
    expect(mockNative.moves).toBe(moves);
  });

  it('a heading frame re-renders the camera only, never its parent (measured)', async () => {
    let parentRenders = 0;
    let cameraCommits = 0;
    function Screen() {
      parentRenders++;
      const [props] = useState({ minZoom: 0 });
      return (
        <Profiler id="camera" onRender={() => cameraCommits++}>
          <HeadingCamera followHeading {...props} />
        </Profiler>
      );
    }
    await render(<Screen />);
    const before = { parentRenders, cameraCommits };
    for (let i = 1; i <= 60; i++) await heading(i);
    expect(parentRenders).toBe(before.parentRenders);
    expect(cameraCommits - before.cameraCommits).toBe(60);
  });
});
