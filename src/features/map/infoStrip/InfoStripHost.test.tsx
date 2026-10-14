/**
 * The info strip on the map (#673): the default strip that replaced 2.5.1's
 * coordinates chip, its copy action, the editor entry, the render budgets
 * (a pan or a heading tick never re-renders the map screen), the stacking
 * it reports, and the recording de-dup.
 */
import { stackOffsets, stripHeightDp } from '@core/infoStrip/layout';
import { DEFAULT_HERO_FIELDS } from '@core/recording/panel';
import type { TrackStats } from '@core/models';
import { useMapStore } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import { darkScheme, lightScheme } from '@ui/tokens';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { Profiler } from 'react';
import { StyleSheet, Text, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { resetCenterElevation } from '../centerElevation';
import { InfoStripHost, type InfoStripHostProps } from './InfoStripHost';
import { InfoStripInsets } from './InfoStripInsets';
import { bottomLiftOf, setStripRuntime, topShiftOf, useStripRuntime } from './stripRuntime';
import { currentStrip, Providers, putStrip, QC, resetStores } from './testUtils';

jest.mock('@data/storage', () => ({ writeJson: jest.fn(), readJson: jest.fn(async () => null) }));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

const mockDem = { elevation: 412.4 as number | null, calls: 0 };
jest.mock('../dem', () => ({
  fetchDemTile: jest.fn(async () => {
    mockDem.calls += 1;
    if (mockDem.elevation === null) throw new Error('offline');
    return new Float32Array(256 * 256).fill(mockDem.elevation);
  }),
}));

type HeadingListener = (s: { headingDeg: number; accuracy: number | null }) => void;
const mockHeading = { listeners: new Set<HeadingListener>(), subscribes: 0 };
jest.mock('../useCompass', () => ({
  subscribeHeading: (l: HeadingListener) => {
    mockHeading.subscribes += 1;
    mockHeading.listeners.add(l);
    return () => mockHeading.listeners.delete(l);
  },
}));

const counts = { strip: 0 };
/** One call per render of the MapScreen stand-in. */
const hostRendered = jest.fn();
const hostRenders = () => hostRendered.mock.calls.length;
const NO_INPUTS: Omit<InfoStripHostProps, 'onCopied'> = {
  location: null,
  fix: null,
  follow: null,
  recording: null,
  bottomLift: 0,
  hidden: false,
};

/** Stands in for MapScreen: counts its own renders, mounts the host as MapScreen does. */
function Screen(props: Partial<InfoStripHostProps>) {
  hostRendered();
  return (
    <Profiler id="strip" onRender={() => (counts.strip += 1)}>
      <InfoStripHost {...NO_INPUTS} onCopied={props.onCopied ?? (() => undefined)} {...props} />
    </Profiler>
  );
}

async function renderStrip(props: Partial<InfoStripHostProps> = {}, dark = false) {
  hostRendered.mockClear();
  counts.strip = 0;
  const utils = await render(
    <Providers dark={dark}>
      <InfoStripInsets>
        <Screen {...props} />
      </InfoStripInsets>
    </Providers>,
  );
  return utils;
}

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const layout = (height: number) => ({ nativeEvent: { layout: { height } } }) as LayoutChangeEvent;
const STATS: TrackStats = {
  distanceM: 8420,
  ascentM: 412,
  descentM: 188,
  durationS: 4360,
  movingTimeS: 3490,
  avgSpeedMps: 1.4,
  maxSpeedMps: 2,
  pointCount: 100,
};

beforeEach(() => {
  resetStores();
  resetCenterElevation();
  mockDem.elevation = 412.4;
  mockDem.calls = 0;
  mockHeading.listeners.clear();
  mockHeading.subscribes = 0;
  (Clipboard.setStringAsync as jest.Mock).mockClear();
});

describe('the default strip (2.5.1 chip, re-homed)', () => {
  it.each([
    ['light', false, lightScheme],
    ['dark', true, darkScheme],
  ] as const)(
    'reads the centre coordinates and its ground elevation, on the %s surface',
    async (_n, dark, scheme) => {
      await renderStrip({}, dark);
      await settle();
      expect(screen.getByTestId('map-coords-text')).toHaveTextContent('46.81394, -71.20761');
      expect(screen.getByTestId('map-coords-altitude')).toHaveTextContent('≈412 m');
      expect(StyleSheet.flatten(screen.getByTestId('info-strip').props.style)).toMatchObject({
        backgroundColor: scheme.surface,
        borderColor: scheme.outlineVariant,
      });
    },
  );

  it('steps the elevation aside while there is no DEM tile (never a stale number)', async () => {
    mockDem.elevation = null;
    await renderStrip();
    await settle();
    expect(screen.getByTestId('map-coords-text')).toBeOnTheScreen();
    expect(screen.queryByTestId('map-coords-altitude')).toBeNull();
  });

  it('reads you while the map follows you: your fix altitude, unmarked', async () => {
    useMapStore.setState({ followUser: true });
    await renderStrip({
      location: { latitude: 46.8, longitude: -71.2 },
      fix: { altitude: 199.6, accuracy: 4 },
    });
    expect(screen.getByTestId('map-coords-text')).toHaveTextContent('46.80000, -71.20000');
    expect(screen.getByTestId('map-coords-altitude')).toHaveTextContent('200 m');
    // No DEM read for "you".
    expect(mockDem.calls).toBe(0);
  });

  it('a tap copies the coordinates alone and says so', async () => {
    const onCopied = jest.fn();
    await renderStrip({ onCopied });
    await settle();
    await fireEvent.press(screen.getByTestId('map-center-coords'));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('46.81394, -71.20761');
    expect(onCopied).toHaveBeenCalledWith('Copied 46.81394, -71.20761');
  });

  it('follows the Settings coordinate format', async () => {
    useSettingsStore.setState({ coordinateFormat: 'utm' });
    await renderStrip();
    expect(screen.getByTestId('map-coords-text')).toHaveTextContent('19T 331586 5186854');
  });

  it('a long-press anywhere opens the editor', async () => {
    await renderStrip();
    expect(screen.queryByTestId('strip-editor')).toBeNull();
    await fireEvent(screen.getByTestId('info-strip'), 'longPress');
    expect(screen.getByTestId('strip-editor')).toBeOnTheScreen();
    expect(useStripRuntime.getState().editorOpen).toBe(true);
  });

  it('an empty strip (2.5.1 switch off) draws nothing and lifts nothing', async () => {
    putStrip({ ...currentStrip(), rows: [] });
    await renderStrip();
    expect(screen.queryByTestId('info-strip')).toBeNull();
    expect(bottomLiftOf(useStripRuntime.getState())).toBe(0);
  });

  it('hides with the region selector or the map maker', async () => {
    await renderStrip({ hidden: true });
    expect(screen.queryByTestId('info-strip')).toBeNull();
  });
});

describe('render budgets (measure, do not assert wall-clock)', () => {
  it('a pan re-renders only the strip, once per settle, never the screen', async () => {
    await renderStrip();
    await settle();
    const host = hostRenders();
    const strip = counts.strip;
    for (let i = 1; i <= 20; i++) {
      await act(async () =>
        useMapStore.getState().setMapCenter({ latitude: QC.latitude + i / 1000, longitude: -71 }),
      );
      await settle();
    }
    expect(hostRenders() - host).toBe(0);
    // One render per settle, plus at most one per DEM tile load landing.
    expect(counts.strip - strip).toBeLessThanOrEqual(20 + mockDem.calls);
    expect(counts.strip - strip).toBeGreaterThanOrEqual(20);
  });

  it('the default strip never starts the compass', async () => {
    await renderStrip();
    expect(mockHeading.subscribes).toBe(0);
  });

  it('heading ticks re-render the strip at most at 4 Hz, never the screen', async () => {
    jest.useFakeTimers({ now: 0 });
    try {
      putStrip('navigation');
      await renderStrip({ location: QC, fix: { altitude: 200, accuracy: 4, speed: 1 } });
      expect(mockHeading.subscribes).toBe(1);
      const host = hostRenders();
      const strip = counts.strip;
      // 40 samples, 25 ms apart (1 s of a turning phone at 40 Hz), 3° each.
      for (let i = 0; i < 40; i++) {
        await act(async () => {
          for (const l of mockHeading.listeners) l({ headingDeg: (i * 3) % 360, accuracy: 3 });
          jest.advanceTimersByTime(25);
        });
      }
      await act(async () => jest.advanceTimersByTime(300));
      expect(hostRenders() - host).toBe(0);
      // 1.3 s at 4 Hz: ≤ 6 heading renders (+1 for the trailing flush, +1 for
      // the ETE field's 1 Hz clock); the needle did move.
      expect(counts.strip - strip).toBeLessThanOrEqual(8);
      expect(counts.strip - strip).toBeGreaterThanOrEqual(3);
      expect(screen.getByTestId('strip-field-heading')).toBeOnTheScreen();
    } finally {
      jest.useRealTimers();
    }
  });
});

/** Reads the safe area as the map's top chrome does. */
function TopProbe() {
  const insets = useSafeAreaInsets();
  return <Text testID="top-probe">{insets.top}</Text>;
}

describe('stacking (owner order: tab bar/panel, strip, tape, ⓘ + scale row)', () => {
  it('bottom dock: sits on the lift and reports its measured height for the column', async () => {
    await renderStrip({ bottomLift: 166 });
    const dock = screen.getByTestId('info-strip').parent!;
    expect(StyleSheet.flatten(dock.props.style)).toMatchObject({
      position: 'absolute',
      bottom: 166,
    });
    const h = stripHeightDp(1);
    await act(async () => fireEvent(screen.getByTestId('info-strip'), 'layout', layout(h)));
    expect(bottomLiftOf(useStripRuntime.getState())).toBe(h);
    expect(topShiftOf(useStripRuntime.getState())).toBe(0);
    // What MapScreen does with it: the column (scale row over the tape) rides on the strip.
    const o = stackOffsets('bottom', h, 166, true);
    expect(o.stripBottom).toBe(166);
    expect(o.tapeBottom! - 8).toBe(166 + h);
    expect(o.scaleRowBottom).toBeGreaterThan(o.tapeBottom!);
  });

  it('top dock: under the status bar, and every piece of top chrome moves down by it', async () => {
    putStrip({ ...currentStrip(), dock: 'top' });
    await render(
      <Providers>
        <InfoStripInsets>
          <Screen />
          <TopProbe />
        </InfoStripInsets>
      </Providers>,
    );
    const strip = screen.getByTestId('info-strip');
    expect(StyleSheet.flatten(strip.parent!.props.style)).toMatchObject({ top: 0 });
    // Its surface reaches up behind the status bar (40 dp here).
    expect(StyleSheet.flatten(strip.props.style).paddingTop).toBeGreaterThanOrEqual(40);
    expect(screen.getByTestId('top-probe')).toHaveTextContent('40');
    const h = 40 + stripHeightDp(1);
    await act(async () => fireEvent(strip, 'layout', layout(h)));
    expect(topShiftOf(useStripRuntime.getState())).toBe(h);
    expect(bottomLiftOf(useStripRuntime.getState())).toBe(0);
    expect(screen.getByTestId('top-probe')).toHaveTextContent(String(40 + h));
    expect(stackOffsets('top', h, 0, false).topChromeShift).toBe(h);
  });

  it('switching the dock moves the lift from one edge to the other', async () => {
    await renderStrip();
    await act(async () => fireEvent(screen.getByTestId('info-strip'), 'layout', layout(37)));
    expect(bottomLiftOf(useStripRuntime.getState())).toBe(37);
    await act(async () => putStrip({ ...currentStrip(), dock: 'top' }));
    expect(bottomLiftOf(useStripRuntime.getState())).toBe(0);
  });
});

describe('recording: the strip stacks on the panel, one owner per metric', () => {
  const recording = { stats: STATS, elapsedS: 4360, liveSpeedMps: 1.2 };

  it('drops the metrics the hero row shows, sits on the panel and squares it', async () => {
    putStrip({
      ...currentStrip(),
      rows: [
        [
          {
            field: 'coords',
            params: {
              point: 'centre',
              format: 'app',
              datum: 'wgs84',
              showAccuracy: false,
              tapToCopy: true,
            },
          },
          { field: 'hero:gain', params: {} },
          { field: 'hero:moving', params: {} },
        ],
      ],
    });
    setStripRuntime({ heroFields: DEFAULT_HERO_FIELDS });
    await renderStrip({ recording, location: QC, bottomLift: 166 });
    // Gain is in the hero row (Time · Distance · Gain): it steps aside.
    expect(screen.queryByTestId('strip-field-hero:gain')).toBeNull();
    expect(screen.getByTestId('strip-field-hero:moving')).toHaveTextContent(/58:10$/);
    expect(useStripRuntime.getState().onPanel).toBe(true);
    // The panel learns what the strip shows (cycling skips them).
    expect([...useStripRuntime.getState().stripMetrics].sort()).toEqual(['gain', 'moving']);
    expect(StyleSheet.flatten(screen.getByTestId('info-strip').props.style)).toMatchObject({
      borderTopLeftRadius: 16,
    });
  });

  it('with the panel minimised the strip shows them all and is not on the panel', async () => {
    putStrip({ ...currentStrip(), rows: [[{ field: 'hero:gain', params: {} }]] });
    setStripRuntime({ heroFields: [] });
    await renderStrip({ recording });
    expect(screen.getByTestId('strip-field-hero:gain')).toHaveTextContent(/\+412 m$/);
    expect(useStripRuntime.getState().onPanel).toBe(false);
  });
});
