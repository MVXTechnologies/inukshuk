import { demTileForPoint } from '@core/geo/pointElevation';
import { useGnssStore } from '@state/gnssStore';
import { useMapStore } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import { formatCoordinateNow } from '@state/useCoordinateFormatter';
import { darkScheme, lightScheme } from '@ui/tokens';
import { darkTheme, lightTheme } from '@ui/theme';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { Profiler } from 'react';
import { StyleSheet, type LayoutChangeEvent } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { resetCenterElevation } from '../centerElevation';
import {
  CenterCoordinatesChip,
  COMPACT_BELOW_DP,
  onChipRowLayout,
  onTipSlotLayout,
  resetChipRoom,
} from './CenterCoordinatesChip';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

const mockWidth = { current: 390 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: mockWidth.current, height: 844, scale: 3, fontScale: 1 }),
}));

/** The DEM fetch + decode (`fetchDemTile`): one call = one fetch and one decode. */
const mockDem = {
  elevation: 412.4 as number | null,
  calls: 0,
  /** While set, loads wait for it (a slow network). */
  hold: null as Promise<void> | null,
};
jest.mock('../dem', () => ({
  fetchDemTile: jest.fn(async () => {
    mockDem.calls += 1;
    if (mockDem.hold !== null) await mockDem.hold;
    if (mockDem.elevation === null) throw new Error('offline-only: not cached');
    return new Float32Array(256 * 256).fill(mockDem.elevation);
  }),
}));

const QC = { latitude: 46.81394, longitude: -71.20761 };

/** Render counters: the host (the map screen's stand-in) and the chip's subtree. */
const counts = { host: 0, chip: 0 };
const countHost = () => {
  counts.host += 1;
};
const countChip = () => {
  counts.chip += 1;
};

/** Stands in for the map screen that hosts the chip, counting its own renders. */
function Host({
  you = null,
  youAltitudeM = null,
  onCopied = () => undefined,
}: {
  you?: { latitude: number; longitude: number } | null;
  youAltitudeM?: number | null;
  onCopied?: (m: string) => void;
}) {
  countHost();
  return (
    <Profiler id="chip" onRender={countChip}>
      <CenterCoordinatesChip you={you} youAltitudeM={youAltitudeM} onCopied={onCopied} />
    </Profiler>
  );
}

async function renderChip(props: Parameters<typeof Host>[0] = {}, dark = false) {
  counts.host = 0;
  counts.chip = 0;
  await render(
    <PaperProvider theme={dark ? darkTheme : lightTheme}>
      <Host {...props} />
    </PaperProvider>,
  );
}

/** Let the DEM load's promise chain settle and its render commit. */
const settleLoads = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const layout = (width: number) => ({ nativeEvent: { layout: { width } } }) as LayoutChangeEvent;
/** The bottom row's measured room: its end side, and the tip button in it. */
const measureRow = (rowW: number, tipW = 0) =>
  act(async () => {
    onChipRowLayout(layout(rowW));
    onTipSlotLayout(layout(tipW));
  });

const chip = () => screen.getByTestId('map-center-coords');
const altitude = () => screen.queryByTestId('map-coords-altitude');
const shown = () => screen.getByTestId('map-coords-text');

describe('CenterCoordinatesChip (#677)', () => {
  beforeEach(() => {
    mockWidth.current = 390;
    mockPush.mockClear();
    mockDem.elevation = 412.4;
    mockDem.calls = 0;
    mockDem.hold = null;
    resetCenterElevation();
    resetChipRoom();
    (Clipboard.setStringAsync as jest.Mock).mockClear();
    useSettingsStore.setState({ showCenterCursor: true, coordinateFormat: 'dd', units: 'metric' });
    useMapStore.setState({ mapCenter: QC, followUser: false });
    useGnssStore.setState({ use: 'phone', fix: null });
  });

  it('reads out the settled map centre in decimal degrees by default', async () => {
    await renderChip();
    expect(screen.getByText('46.81394, -71.20761')).toBeOnTheScreen();
    expect(chip()).toHaveProp('accessibilityLabel', 'Map centre 46.81394, -71.20761');
    expect(screen.queryByTestId('map-coords-you', { includeHiddenElements: true })).toBeNull();
  });

  it('writes the coordinates in the format chosen in Settings, and re-labels when it flips', async () => {
    useSettingsStore.setState({ coordinateFormat: 'mgrs' });
    await renderChip();
    expect(screen.getByText('19T CM 31586 86854')).toBeOnTheScreen();
    await act(async () => useSettingsStore.setState({ coordinateFormat: 'dms' }));
    expect(screen.getByText('46°48′50.2″N, 71°12′27.4″W')).toBeOnTheScreen();
  });

  it('drops to the compact form on a narrow (360 dp) screen', async () => {
    mockWidth.current = 360;
    expect(360).toBeLessThan(COMPACT_BELOW_DP);
    await renderChip();
    expect(screen.getByText('46.8139, -71.2076')).toBeOnTheScreen();
  });

  it('keeps full precision at 390 dp, the mockup width', async () => {
    expect(390).toBeGreaterThanOrEqual(COMPACT_BELOW_DP);
    await renderChip();
    expect(screen.getByText('46.81394, -71.20761')).toBeOnTheScreen();
  });

  it('tap copies the coordinates and confirms exactly what was copied', async () => {
    useSettingsStore.setState({ coordinateFormat: 'utm' });
    const onCopied = jest.fn();
    await renderChip({ onCopied });
    fireEvent.press(chip());
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('19T 331586 5186854');
    expect(onCopied).toHaveBeenCalledWith('Copied 19T 331586 5186854');
  });

  it('long-press opens Convert with the point prefilled', async () => {
    await renderChip();
    fireEvent(chip(), 'longPress');
    expect(mockPush).toHaveBeenCalledTimes(1);
    const href = mockPush.mock.calls[0]?.[0] as {
      pathname: string;
      params: Record<string, string>;
    };
    expect(href.pathname).toBe('/convert');
    expect(Object.values(href.params).join(' ')).toContain('46.81394');
    expect(Object.values(href.params).join(' ')).toContain('-71.20761');
  });

  it('while following, shows YOUR position with a "you" mark, and copies that', async () => {
    const onCopied = jest.fn();
    await renderChip({ you: { latitude: 47.5, longitude: -70.25 }, onCopied });
    expect(screen.getByText('47.50000, -70.25000')).toBeOnTheScreen();
    expect(screen.getByTestId('map-coords-you', { includeHiddenElements: true })).toBeOnTheScreen();
    expect(chip()).toHaveProp('accessibilityLabel', 'Your position 47.50000, -70.25000');
    fireEvent.press(chip());
    expect(onCopied).toHaveBeenCalledWith('Copied 47.50000, -70.25000');
  });

  it('draws nothing before the first settle, or with the setting off', async () => {
    useMapStore.setState({ mapCenter: null });
    await renderChip();
    expect(screen.queryByTestId('map-center-coords')).toBeNull();
    await act(async () => useMapStore.setState({ mapCenter: QC }));
    expect(chip()).toBeOnTheScreen();
    await act(async () => useSettingsStore.setState({ showCenterCursor: false }));
    expect(screen.queryByTestId('map-center-coords')).toBeNull();
  });

  it('never shows 0, 0 nor its sea-floor depth before a real camera exists (2.5.2 QA)', async () => {
    useMapStore.setState({ mapCenter: { latitude: 0, longitude: 0 } });
    const before = mockDem.calls;
    await renderChip();
    await settleLoads();
    expect(screen.queryByTestId('map-center-coords')).toBeNull();
    expect(screen.queryByText(/0\.00000/)).toBeNull();
    expect(mockDem.calls).toBe(before);
    // Nor a "you" at null island.
    await renderChip({ you: { latitude: 0, longitude: 0 } });
    expect(screen.queryByTestId('map-center-coords')).toBeNull();
    // The first real settle: there it is.
    await renderChip();
    await act(async () => useMapStore.setState({ mapCenter: QC }));
    expect(chip()).toBeOnTheScreen();
  });

  it('ignores map-store traffic that is not its centre (no re-render)', async () => {
    await renderChip();
    await settleLoads();
    const mounted = counts.chip;
    await act(async () => {
      // A settle at the same centre (follow-mode nudges, rotate-only gestures)…
      useMapStore.getState().setMapCenter({ ...QC });
      // …and unrelated map state.
      useMapStore.getState().toggleWeatherAnimation();
      useMapStore.getState().toggleTrackOverlays();
    });
    expect(counts.chip - mounted).toBe(0);
  });

  it.each([
    ['light', false, lightScheme],
    ['dark', true, darkScheme],
  ] as const)('uses the scale bar chip colours in %s', async (_name, dark, scheme) => {
    await measureRow(260);
    await renderChip({}, dark);
    await settleLoads();
    expect(StyleSheet.flatten(chip().props.style as never)).toMatchObject({
      backgroundColor: scheme.map.chip,
    });
    expect(StyleSheet.flatten(shown().props.style)).toMatchObject({ color: scheme.map.chipInk });
    // The altitude is the quieter second part.
    expect(StyleSheet.flatten(altitude()?.props.style)).toMatchObject({
      color: scheme.map.chipInkMuted,
    });
  });

  it('formatCoordinateNow reads the same setting outside a render', () => {
    useSettingsStore.setState({ coordinateFormat: 'ddm' });
    expect(formatCoordinateNow(QC.latitude, QC.longitude)).toBe('46°48.836′N, 71°12.457′W');
  });

  describe('altitude', () => {
    it('map centre: the DEM ground elevation, marked approximate, once its tile lands', async () => {
      await measureRow(260);
      let release = () => undefined as void;
      mockDem.hold = new Promise<void>((r) => {
        release = r;
      });
      await renderChip();
      await settleLoads();
      expect(altitude()).toBeNull(); // no spinner, no placeholder while loading
      expect(shown()).toHaveTextContent('46.81394, -71.20761');
      release();
      await settleLoads();
      expect(shown()).toHaveTextContent('46.81394, -71.20761  ·  ≈412 m');
      expect(chip()).toHaveProp(
        'accessibilityLabel',
        'Map centre 46.81394, -71.20761, ground elevation about 412 m',
      );
      expect(mockDem.calls).toBe(1);
    });

    it('tap still copies the coordinates alone (they paste cleanly anywhere)', async () => {
      await measureRow(260);
      const onCopied = jest.fn();
      await renderChip({ onCopied });
      await settleLoads();
      expect(altitude()).not.toBeNull();
      fireEvent.press(chip());
      expect(Clipboard.setStringAsync).toHaveBeenCalledWith('46.81394, -71.20761');
      expect(onCopied).toHaveBeenCalledWith('Copied 46.81394, -71.20761');
    });

    it('follows the unit setting', async () => {
      useSettingsStore.setState({ units: 'imperial' });
      await measureRow(260);
      await renderChip();
      await settleLoads();
      expect(shown()).toHaveTextContent('46.81394, -71.20761  ·  ≈1353 ft');
    });

    it('offline with no cached tile: the coordinates alone, never "0 m", no retry storm', async () => {
      mockDem.elevation = null;
      await measureRow(260);
      await renderChip();
      await settleLoads();
      expect(altitude()).toBeNull();
      expect(shown()).toHaveTextContent('46.81394, -71.20761');
      expect(screen.queryByText(/0 m/)).toBeNull();
      // More idles in the failed tile: no new fetch until the failure ages out.
      for (let i = 1; i <= 5; i++) {
        await act(async () =>
          useMapStore
            .getState()
            .setMapCenter({ latitude: QC.latitude + i * 1e-4, longitude: -71.2 }),
        );
        await settleLoads();
      }
      expect(mockDem.calls).toBe(1);
    });

    it('never shows the previous point’s number while the new tile loads', async () => {
      await measureRow(260);
      await renderChip();
      await settleLoads();
      expect(altitude()).not.toBeNull();
      mockDem.elevation = 95;
      let release = () => undefined as void;
      mockDem.hold = new Promise<void>((r) => {
        release = r;
      });
      // A settle far away, in another tile: the old 412 must go at once.
      await act(async () =>
        useMapStore.getState().setMapCenter({ latitude: 45.5, longitude: -73.56 }),
      );
      await settleLoads();
      expect(altitude()).toBeNull();
      release();
      await settleLoads();
      expect(shown()).toHaveTextContent('45.50000, -73.56000  ·  ≈95 m');
    });

    it('50 idles in one tile: one fetch, one decode; the host never re-renders', async () => {
      await measureRow(260);
      const tile = demTileForPoint(QC.latitude, QC.longitude)?.key;
      await renderChip();
      await settleLoads();
      const mounted = counts.chip;
      for (let i = 1; i <= 50; i++) {
        const at = { latitude: QC.latitude + i * 1e-5, longitude: QC.longitude + i * 1e-5 };
        expect(demTileForPoint(at.latitude, at.longitude)?.key).toEqual(tile);
        await act(async () => useMapStore.getState().setMapCenter(at));
        await settleLoads();
      }
      expect(mockDem.calls).toBe(1); // one fetch + decode for the whole session
      expect(counts.host).toBe(1); // MapScreen's stand-in: zero re-renders
      expect(counts.chip - mounted).toBe(50); // one render per idle: cache hits are synchronous
      expect(shown()).toHaveTextContent(/· ≈412 m$/);
    });

    it('following: your fix’s altitude as the recorder shows it, no "≈"', async () => {
      await measureRow(260);
      await renderChip({ you: { latitude: 47.5, longitude: -70.25 }, youAltitudeM: 250.6 });
      await settleLoads();
      expect(shown()).toHaveTextContent('47.50000, -70.25000  ·  251 m');
      expect(mockDem.calls).toBe(0); // no DEM read while following
    });

    it('following with a fix that has no altitude: none shown', async () => {
      await measureRow(260);
      await renderChip({ you: { latitude: 47.5, longitude: -70.25 }, youAltitudeM: null });
      await settleLoads();
      expect(altitude()).toBeNull();
    });

    it('following an external receiver: its MSL altitude, the one the recorder stores', async () => {
      useGnssStore.setState({ use: 'external', fix: { hMsl: 101.2, hEll: 70.1 } as never });
      await measureRow(260);
      await renderChip({ you: { latitude: 47.5, longitude: -70.25 }, youAltitudeM: 999 });
      expect(shown()).toHaveTextContent('47.50000, -70.25000  ·  101 m');
      await act(async () => useGnssStore.setState({ fix: null }));
      expect(altitude()).toBeNull();
    });

    it('360 dp: the altitude drops before anything wraps; the coordinates stay', async () => {
      mockWidth.current = 360;
      // 360 − 32 gutters − (24 ⓘ + 6 + 94 scale) − 6 gap = 198 dp of row, tip button up.
      await measureRow(198, 36);
      await renderChip();
      await settleLoads();
      expect(altitude()).toBeNull();
      expect(shown()).toHaveTextContent('46.8139, -71.2076');
      expect(shown()).toHaveProp('numberOfLines', 1);
      expect(shown()).toHaveProp('adjustsFontSizeToFit', true);
      // The tip button goes (recording, navigating): now there is room.
      await measureRow(198, 0);
      expect(shown()).toHaveTextContent('46.8139, -71.2076  ·  ≈412 m');
    });

    it('before the row is measured, it assumes the narrowest case', async () => {
      mockWidth.current = 360;
      await renderChip();
      await settleLoads();
      expect(altitude()).toBeNull();
    });
  });
});
