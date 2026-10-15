/**
 * The cursor fields' live centre (owner: "Bearing/Distance to cursor"):
 * MapScreen publishes every camera report as a plain call; the strip leaf
 * re-renders at most 10 times a second, ending on the pan's last centre, and
 * draws the cursor as the map does.
 */
import { CURSOR_TICK_MS } from '@core/infoStrip/cursor';
import { useMapStore } from '@state/mapStore';
import { lightTheme } from '@ui/theme';
import { act, render, screen } from '@testing-library/react-native';
import { Profiler } from 'react';
import { Text } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { publishLiveCentre, resetLiveCentre, useLiveCentre } from './liveCentre';
import { StripField } from './StripField';

/** Commits of the probe (React's Profiler), and the centre it last drew. */
const probe = { renders: 0 };
const counted = () => {
  probe.renders += 1;
};
function Centre({ on }: { on: boolean }) {
  const c = useLiveCentre(on);
  return <Text testID="centre">{c === null ? 'none' : `${c.latitude},${c.longitude}`}</Text>;
}
function Probe({ on }: { on: boolean }) {
  return (
    <Profiler id="probe" onRender={counted}>
      <Centre on={on} />
    </Profiler>
  );
}
const shown = () => screen.getByTestId('centre').props.children as string;

/**
 * A 60 Hz pan of `ms`, eastwards from Québec City, one frame per act (as the
 * native reports arrive); returns the last centre.
 */
async function pan(ms: number): Promise<[number, number]> {
  let at: [number, number] = [-71.2, 46.8];
  for (let t = 0; t <= ms; t += 1000 / 60) {
    at = [-71.2 + t * 1e-6, 46.8];
    const frame = at;
    await act(async () => {
      publishLiveCentre(frame);
      jest.advanceTimersByTime(1000 / 60);
    });
  }
  await act(async () => {
    jest.advanceTimersByTime(CURSOR_TICK_MS);
  });
  return at;
}

describe('useLiveCentre', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    resetLiveCentre();
    useMapStore.setState({ mapCenter: { latitude: 46.81, longitude: -71.21 } });
    probe.renders = 0;
  });
  afterEach(() => {
    jest.useRealTimers();
    resetLiveCentre();
  });

  it('starts on the settled centre, then follows a pan at most 10 times a second', async () => {
    await render(<Probe on />);
    expect(shown()).toBe('46.81,-71.21');
    probe.renders = 0;
    const last = await pan(1000);
    // 61 camera reports in one second: ~10 renders (one per tick), never 61.
    expect(probe.renders).toBeLessThanOrEqual(12);
    expect(probe.renders).toBeGreaterThanOrEqual(8);
    // The pan's last centre is never lost.
    expect(shown()).toBe(`${last[1]},${last[0]}`);
  });

  it('off: no subscription, no renders, null', async () => {
    await render(<Probe on={false} />);
    probe.renders = 0;
    await pan(500);
    expect(probe.renders).toBe(0);
    expect(shown()).toBe('none');
  });

  it('a camera report is not React state: the map store is untouched', async () => {
    const before = useMapStore.getState();
    await render(<Probe on />);
    await pan(300);
    expect(useMapStore.getState()).toBe(before);
  });
});

describe('StripField: a reading to the cursor', () => {
  it('draws the cursor as the map does, never with the map cursor test ids', async () => {
    const subject = {
      key: 'cursor',
      name: 'Cursor',
      glyph: 'filter_center_focus',
      spokenName: 'cursor',
      cursor: { kind: 'reticle' as const, color: '#D32F2F', halo: true },
    };
    await render(
      <PaperProvider theme={lightTheme}>
        <StripField value={{ value: '1.20', unit: 'km', subject }} fit testID="f" />
      </PaperProvider>,
    );
    const hidden = { includeHiddenElements: true };
    expect(screen.getByTestId('strip-subject-cursor', hidden)).toBeOnTheScreen();
    expect(screen.getByTestId('strip-subject-cursor-reticle', hidden)).toBeOnTheScreen();
    expect(screen.queryByTestId('map-center-reticle', hidden)).toBeNull();
  });
});
