/**
 * "Rotate map with compass": the camera bearing follows the display-rate
 * heading, one jump per frame (no native ease for the location component to
 * cancel), re-rendering the camera only — never the screen that holds it.
 */
import { act, render } from '@testing-library/react-native';
import { Profiler, useState } from 'react';
import { HeadingCamera } from './HeadingCamera';

type Props = Record<string, unknown>;
const mockCameraProps: Props[] = [];
jest.mock('@maplibre/maplibre-react-native', () => ({
  Camera: (props: Props) => {
    mockCameraProps.push(props);
    return null;
  },
}));

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
});

describe('HeadingCamera', () => {
  it('off: a plain camera, no bearing, and no heading subscription', async () => {
    await render(<HeadingCamera followHeading={false} minZoom={0} />);
    expect(mockListeners.size).toBe(0);
    const last = mockCameraProps.at(-1)!;
    expect(last.minZoom).toBe(0);
    expect('bearing' in last).toBe(false);
    expect('duration' in last).toBe(false);
  });

  it('on: every heading frame is one camera bearing, applied without a transition', async () => {
    await render(<HeadingCamera followHeading trackUserLocation="default" />);
    for (let i = 1; i <= 30; i++) await heading(100 + i * 1.5);
    const bearings = mockCameraProps.filter((p) => 'bearing' in p);
    expect(bearings).toHaveLength(30);
    for (const p of bearings) {
      expect(p.duration).toBe(0);
      expect(p.trackUserLocation).toBe('default');
    }
    expect(bearings.at(-1)?.bearing).toBe(145);
  });

  it('turning the setting off unsubscribes and leaves the bearing alone', async () => {
    const view = await render(<HeadingCamera followHeading />);
    await heading(42);
    expect(mockCameraProps.at(-1)?.bearing).toBe(42);
    await view.rerender(<HeadingCamera followHeading={false} />);
    expect(mockListeners.size).toBe(0);
    expect('bearing' in mockCameraProps.at(-1)!).toBe(false);
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
