/**
 * The info strip's 2.6.0 follow-ups:
 * - #696: a tap on the target name opens its target, on MapScreen's own card
 *   paths (`onOpenTarget`);
 * - #695: the tide fields read a station (nearest by default, or picked),
 *   from the Tide stations extension's list, fetched every 10 minutes and
 *   never per tick.
 */
import { ref } from '@core/infoStrip/presets';
import { NEAREST_STATION, type InfoStrip } from '@core/infoStrip/types';
import type { FollowReadout } from '@core/nav';
import { parseChsStationList } from '@core/tides/chs';
import type { LiveTide } from '@core/tides/live';
import { useLibraryStore } from '@state/libraryStore';
import { useNavigationStore } from '@state/navigationStore';
import { useSettingsStore } from '@state/settingsStore';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { InfoStripHost, type InfoStripHostProps } from './InfoStripHost';
import { openStripEditor } from './stripRuntime';
import { currentStrip, Providers, putStrip, QC, resetStores } from './testUtils';

jest.mock('@data/storage', () => ({ writeJson: jest.fn(), readJson: jest.fn(async () => null) }));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('../dem', () => ({
  fetchDemTile: jest.fn(async () => new Float32Array(256 * 256).fill(212)),
}));
jest.mock('../useCompass', () => ({ subscribeHeading: () => () => undefined }));

const mockInstalled = { set: new Set<string>() };
jest.mock('./stripSettings', () => ({
  ...jest.requireActual('./stripSettings'),
  useInstalledExtensions: () => mockInstalled.set,
}));

/** SYNTHETIC stations shaped like CHS IWLS /stations (names and ids made up). */
const mockChs = {
  list: parseChsStationList(
    [
      ['00001', 'Anse-Fictive', 46.8, -71.2, true],
      ['00002', 'Port-Exemple', 46.82, -71.19, false],
      ['00003', 'Cap-Imaginaire', 47.5, -70.0, true],
    ].map(([code, name, lat, lng, live]) => ({
      id: `synth-${String(code)}`,
      code,
      officialName: name,
      latitude: lat,
      longitude: lng,
      operating: live,
      timeSeries: live ? [{ code: 'wlo' }, { code: 'wlp-hilo' }] : [{ code: 'wlp-hilo' }],
    })),
  ),
  enabled: [] as boolean[],
};
jest.mock('../hooks/useChs', () => ({
  useChsStations: (on: boolean) => {
    mockChs.enabled.push(on);
    return on ? mockChs.list : null;
  },
}));

/** 2026-10-13 15:00 UTC. */
const NOW = Date.UTC(2026, 9, 13, 15, 0);
const mockLive = {
  answer: {
    level: { heightM: 3.84, timeMs: NOW - 60_000 },
    trend: 'rising',
    nextHigh: { timeMs: NOW + 3 * 3_600_000, heightM: 5.1, kind: 'high' },
    nextLow: null,
  } as LiveTide,
  fail: false,
};
/** The answer, its level observed a minute before the (real or fake) clock: fresh. */
const liveAnswer = async (_s: { name: string }): Promise<LiveTide> => {
  if (mockLive.fail) throw new Error('offline');
  const { level } = mockLive.answer;
  return {
    ...mockLive.answer,
    level: level === null ? null : { ...level, timeMs: Date.now() - 60_000 },
  };
};
const mockLoad = jest.fn(liveAnswer);
jest.mock('../hooks/useLiveTide', () => ({
  loadLiveTide: (s: { name: string }) => mockLoad(s),
}));

const onOpenTarget = jest.fn();
const BASE: InfoStripHostProps = {
  location: null,
  fix: null,
  follow: null,
  recording: null,
  bottomLift: 0,
  hidden: false,
  onCopied: () => undefined,
  onOpenTarget,
};

async function mount(props: Partial<InfoStripHostProps> = {}, dark = false) {
  const utils = await render(
    <Providers dark={dark}>
      <InfoStripHost {...BASE} {...props} />
    </Providers>,
  );
  const rerender = (next: Partial<InfoStripHostProps>) =>
    utils.rerender(
      <Providers dark={dark}>
        <InfoStripHost {...BASE} {...props} {...next} />
      </Providers>,
    );
  return { ...utils, rerender };
}

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

function stripOf(rows: InfoStrip['rows'], target: InfoStrip['target'] = { kind: 'navTarget' }) {
  putStrip({ ...currentStrip(), rows, target });
}

function readout(target: FollowReadout['target']): FollowReadout {
  return {
    alongM: 100,
    crossTrackM: 4,
    onTrail: true,
    nearest: QC,
    trailBearingDeg: 4,
    target,
    targetBearingDeg: 22,
    targetDistanceM: 1404,
    cost: { segments: 0, cells: 0, windowSegments: 0, global: false },
  };
}

beforeEach(() => {
  resetStores();
  onOpenTarget.mockClear();
  mockLoad.mockClear();
  mockLoad.mockImplementation(liveAnswer);
  mockLive.fail = false;
  mockChs.enabled = [];
  mockInstalled.set = new Set();
  useSettingsStore.setState({ offlineOnly: false });
  useLibraryStore.setState({
    waypoints: [
      { id: 'w1', label: 'Camp lac', latitude: 46.82, longitude: -71.2, createdAt: 0 },
    ] as never,
  });
});

describe('#696: a tap on the target name opens the target', () => {
  it.each([false, true])('a saved waypoint → its card (dark %s)', async (dark) => {
    stripOf([[ref('targetName')]], { kind: 'waypoint', waypointId: 'w1' });
    await mount({}, dark);
    const field = screen.getByTestId('strip-field-targetName');
    expect(field).toHaveTextContent(/Camp lac/);
    expect(field.props.accessibilityHint).toBe('Opens the target');
    await fireEvent.press(field);
    expect(onOpenTarget).toHaveBeenCalledTimes(1);
    expect(onOpenTarget).toHaveBeenCalledWith({ kind: 'waypoint', waypointId: 'w1' });
  });

  it("the followed trail's next waypoint → its card; a note or the end → the point chip", async () => {
    stripOf([[ref('targetName')]]);
    const wp = { kind: 'waypoint' as const, id: 'w1', name: 'Camp lac', at: QC, alongM: 1500 };
    const { rerender } = await mount({
      location: QC,
      follow: { name: 'Sentier', readout: readout(wp) },
    });
    await fireEvent.press(screen.getByTestId('strip-field-targetName'));
    expect(onOpenTarget).toHaveBeenLastCalledWith({ kind: 'waypoint', waypointId: 'w1' });

    const notePoint = { latitude: 46.83, longitude: -71.21 };
    const note = { kind: 'note' as const, id: 'n1', name: 'Belvédère', at: notePoint, alongM: 900 };
    await rerender({ location: QC, follow: { name: 'Sentier', readout: readout(note) } });
    expect(screen.getByTestId('strip-field-targetName')).toHaveTextContent(/Belvédère/);
    await fireEvent.press(screen.getByTestId('strip-field-targetName'));
    expect(onOpenTarget).toHaveBeenLastCalledWith({ kind: 'point', point: notePoint });

    const end = { kind: 'end' as const, id: 'end', name: 'Trail end', at: notePoint, alongM: 3000 };
    await rerender({ location: QC, follow: { name: 'Sentier', readout: readout(end) } });
    await fireEvent.press(screen.getByTestId('strip-field-targetName'));
    expect(onOpenTarget).toHaveBeenLastCalledWith({ kind: 'point', point: notePoint });
  });

  it('the destination pin → the point chip there', async () => {
    const pin = { latitude: 46.9, longitude: -71.1 };
    useNavigationStore.setState({ destination: pin });
    stripOf([[ref('targetName')]]);
    await mount();
    expect(screen.getByTestId('strip-field-targetName')).toHaveTextContent(/Destination/);
    await fireEvent.press(screen.getByTestId('strip-field-targetName'));
    expect(onOpenTarget).toHaveBeenCalledWith({ kind: 'point', point: pin });
  });

  it("a field's own target wins over the strip's", async () => {
    useNavigationStore.setState({ destination: { latitude: 46.9, longitude: -71.1 } });
    stripOf([[ref('targetName', { target: { kind: 'waypoint', waypointId: 'w1' } })]]);
    await mount();
    await fireEvent.press(screen.getByTestId('strip-field-targetName'));
    expect(onOpenTarget).toHaveBeenCalledWith({ kind: 'waypoint', waypointId: 'w1' });
  });

  it('a long-press still opens the editor, not the target', async () => {
    stripOf([[ref('targetName')]], { kind: 'waypoint', waypointId: 'w1' });
    await mount();
    await fireEvent(screen.getByTestId('strip-field-targetName'), 'longPress');
    expect(screen.getByTestId('strip-editor')).toBeOnTheScreen();
    expect(onOpenTarget).not.toHaveBeenCalled();
  });

  it('other fields keep no tap action', async () => {
    stripOf([[ref('targetName'), ref('targetDistance')]], { kind: 'waypoint', waypointId: 'w1' });
    await mount({ location: QC });
    expect(screen.getByTestId('strip-field-targetDistance').props.accessibilityHint).toBe(
      undefined,
    );
  });
});

describe('#695: tide fields read a station', () => {
  const PADDLING = [[ref('tides:level'), ref('tides:nextHigh')]];
  const near = { latitude: 46.81, longitude: -71.21 };

  it.each([false, true])(
    'nearest station: its level, trend and next high (dark %s)',
    async (dark) => {
      jest.useFakeTimers({ now: NOW });
      try {
        mockInstalled.set = new Set(['tides']);
        stripOf(PADDLING);
        await mount({ location: near }, dark);
        await act(async () => undefined);
        expect(mockLoad).toHaveBeenCalledTimes(1);
        expect(mockLoad.mock.calls[0]![0].name).toBe('Anse-Fictive');
        expect(screen.getByTestId('strip-field-tides:level')).toHaveTextContent(
          /Anse-Fictive.*\+3\.84.*m ↑/,
        );
        expect(screen.getByTestId('strip-field-tides:nextHigh')).toHaveTextContent(/High/);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('without the extension: nothing loads and the fields step aside', async () => {
    stripOf([[ref('tides:level'), ref('speed')]]);
    await mount({ location: near, fix: { speed: 1 } });
    await settle();
    expect(screen.queryByTestId('strip-field-tides:level')).toBeNull();
    expect(mockLoad).not.toHaveBeenCalled();
    expect(mockChs.enabled.every((on) => !on)).toBe(true);
  });

  it('a strip without tide fields never reads the station list', async () => {
    mockInstalled.set = new Set(['tides']);
    stripOf([[ref('speed')]]);
    await mount({ location: near, fix: { speed: 1 } });
    await settle();
    expect(mockChs.enabled.every((on) => !on)).toBe(true);
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('a picked station is read wherever you are', async () => {
    mockInstalled.set = new Set(['tides']);
    stripOf([[ref('tides:level', { station: '100:00003' })]]);
    await mount({ location: near });
    await settle();
    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(mockLoad.mock.calls[0]![0].name).toBe('Cap-Imaginaire');
    expect(screen.getByTestId('strip-field-tides:level')).toHaveTextContent(/Cap-Imaginaire/);
  });

  it('nothing near: the fields step aside, nothing loads', async () => {
    mockInstalled.set = new Set(['tides']);
    stripOf(PADDLING);
    await mount({ location: { latitude: 10, longitude: 10 } });
    await settle();
    expect(screen.queryByTestId('strip-field-tides:level')).toBeNull();
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('tick cost: fixes in the same cell fetch nothing; a refresh each 10 min, then the level drops offline', async () => {
    jest.useFakeTimers({ now: NOW });
    try {
      mockInstalled.set = new Set(['tides']);
      stripOf(PADDLING);
      const { rerender } = await mount({ location: near });
      await act(async () => undefined);
      expect(mockLoad).toHaveBeenCalledTimes(1);
      // 30 fixes a few metres apart: same cell, same station, no request.
      for (let i = 1; i <= 30; i++) {
        await rerender({ location: { latitude: near.latitude + i * 1e-5, longitude: -71.21 } });
      }
      expect(mockLoad).toHaveBeenCalledTimes(1);
      // Nine minutes of minute ticks: no request either.
      await act(async () => jest.advanceTimersByTime(9 * 60_000));
      expect(mockLoad).toHaveBeenCalledTimes(1);
      // The tenth minute refreshes, once. Offline now: the level goes, the high stays.
      mockLive.fail = true;
      await act(async () => jest.advanceTimersByTime(60_000));
      expect(mockLoad).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId('strip-field-tides:level')).toBeNull();
      expect(screen.getByTestId('strip-field-tides:nextHigh')).toBeOnTheScreen();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a station no longer resolved is dropped: back near it, no old level before the refetch', async () => {
    jest.useFakeTimers({ now: NOW });
    try {
      mockInstalled.set = new Set(['tides']);
      stripOf([[ref('tides:level')]]);
      const { rerender } = await mount({ location: near });
      await act(async () => undefined);
      expect(screen.getByTestId('strip-field-tides:level')).toHaveTextContent(/Anse-Fictive/);
      // Far from every station: nothing resolves.
      await rerender({ location: { latitude: 10, longitude: 10 } });
      expect(screen.queryByTestId('strip-field-tides:level')).toBeNull();
      // Back near it, the refetch still in flight: the old reading must not come back.
      mockLoad.mockImplementationOnce(() => new Promise<LiveTide>(() => undefined));
      await rerender({ location: near });
      await act(async () => undefined);
      expect(mockLoad).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId('strip-field-tides:level')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a level that stops refreshing goes once it is an hour old', async () => {
    jest.useFakeTimers({ now: NOW });
    try {
      mockInstalled.set = new Set(['tides']);
      stripOf([[ref('tides:level')]]);
      await mount({ location: near });
      await act(async () => undefined);
      expect(screen.getByTestId('strip-field-tides:level')).toBeOnTheScreen();
      // Every refresh hangs (a captive portal): the observation only ages.
      mockLoad.mockImplementation(() => new Promise<LiveTide>(() => undefined));
      await act(async () => jest.advanceTimersByTime(50 * 60_000));
      expect(screen.getByTestId('strip-field-tides:level')).toBeOnTheScreen();
      await act(async () => jest.advanceTimersByTime(11 * 60_000));
      expect(screen.queryByTestId('strip-field-tides:level')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('the clock reads now when it starts: a field placed hours later never shows the mount time', async () => {
    jest.useFakeTimers({ now: NOW });
    try {
      mockInstalled.set = new Set(['tides']);
      // No field reads the clock: no timer runs, the clock state stays at the mount.
      stripOf([[ref('speed')]]);
      const view = await mount({ location: near, fix: { speed: 1 } });
      await act(async () => jest.advanceTimersByTime(4 * 3_600_000));
      // Four hours on, the next high (3 h after the mount) has passed.
      await act(async () => stripOf([[ref('tides:nextHigh')]]));
      await act(async () => undefined);
      expect(mockLoad).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('strip-field-tides:nextHigh')).toBeNull();
      view.unmount();
    } finally {
      jest.useRealTimers();
    }
  });

  it('offline-only mode fetches nothing', async () => {
    mockInstalled.set = new Set(['tides']);
    useSettingsStore.setState({ offlineOnly: true });
    stripOf(PADDLING);
    await mount({ location: near });
    await settle();
    expect(mockLoad).not.toHaveBeenCalled();
    expect(screen.queryByTestId('strip-field-tides:level')).toBeNull();
  });

  it.each([false, true])(
    'the station picker: Nearest (naming it), then nearby live stations (dark %s)',
    async (dark) => {
      mockInstalled.set = new Set(['tides']);
      stripOf(PADDLING);
      await mount({ location: near }, dark);
      await act(async () => openStripEditor());
      await fireEvent.press(screen.getByTestId('strip-edit-field-0-0'));
      expect(screen.getByText('Tide at a station')).toBeOnTheScreen();
      const nearest = screen.getByTestId(`strip-station-${NEAREST_STATION}`);
      expect(nearest.props.accessibilityState).toMatchObject({ checked: true });
      expect(nearest).toHaveTextContent(/Nearest.*Anse-Fictive/);
      // Live gauges only, nearest first; the prediction-only port is not listed.
      expect(screen.getByTestId('strip-station-100:00001')).toHaveTextContent(/Anse-Fictive/);
      // Its distance as the app writes one ("120 km"), never "119.87 km" (QA 2.6.0).
      expect(screen.getByTestId('strip-station-100:00003')).toHaveTextContent(
        /Cap-Imaginaire\s*\d+ km$/,
      );
      expect(screen.queryByTestId('strip-station-100:00002')).toBeNull();
      await fireEvent.press(screen.getByTestId('strip-station-100:00003'));
      expect(currentStrip().rows[0]![0]!.params.station).toBe('100:00003');
      await fireEvent.press(screen.getByTestId(`strip-station-${NEAREST_STATION}`));
      expect(currentStrip().rows[0]![0]!.params.station).toBe(NEAREST_STATION);
    },
  );
});

describe('moving speed: timed by the fixes themselves', () => {
  it('a burst of queued fixes (one JS moment) still measures the walk they describe', async () => {
    jest.useFakeTimers({ now: NOW });
    try {
      // A destination 2 km north; ETE reads the 10-minute moving speed.
      useNavigationStore.setState({ destination: { latitude: 46.8, longitude: -71.2 } });
      stripOf([[ref('ete')]]);
      const start = { latitude: 46.78, longitude: -71.2 };
      const at = (i: number) => ({
        latitude: start.latitude + (i * 1.2) / 111_195,
        longitude: -71.2,
      });
      const { rerender } = await mount({ location: start, fix: { accuracy: 4, time: NOW } });
      // 150 s of walking at 1.2 m/s, delivered in one burst (a woken JS thread):
      // the clock does not move between them, their own times do.
      for (let i = 1; i <= 150; i++) {
        await rerender({ location: at(i), fix: { accuracy: 4, time: NOW + i * 1000 } });
      }
      await act(async () => jest.advanceTimersByTime(150_000));
      expect(screen.getByTestId('strip-field-ete')).toHaveTextContent(/ETE.*\d:\d\d/);
    } finally {
      jest.useRealTimers();
    }
  });
});
