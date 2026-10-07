import { liteEngine } from '@core/convert/lite';
import { receiverChip } from '@core/gnss/chip';
import { DEFAULT_GNSS_CONFIG, newProfile } from '@core/gnss/config';
import { FixOutputs } from '@core/gnss/output';
import { projectDatumOption } from '@core/gnss/projectDatum';
import { fixOf } from '@core/gnss/testUtils';
import { defaultExtensionPrefs } from '@core/extensions/prefs';
import type { Engine } from '@core/convert/run';
import { installPack, packIndex } from '@data/projGrids';
import { useConvertStore } from '@state/convertStore';
import { useGnssStore } from '@state/gnssStore';
import { useSettingsStore } from '@state/settingsStore';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { MD3DarkTheme, MD3LightTheme, PaperProvider } from 'react-native-paper';

import { ReceiverChipView } from './ReceiverChipView';
import { ReceiverMapOverlay } from './ReceiverMapOverlay';
import { totalAccuracy } from './ReceiverSheet';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush, back: jest.fn() }) }));
jest.mock('@data/storage', () => ({
  newId: () => 'id',
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
}));
jest.mock('@lib/nativeProj', () => ({
  nativeEngine: () => null,
  initNativeProj: jest.fn(),
  nativeProjInfo: () => null,
}));
jest.mock('@data/projGrids', () => ({ packIndex: jest.fn(), installPack: jest.fn() }));

const NOW = Date.UTC(2026, 9, 7, 12);

function wrap(children: ReactNode, dark = false) {
  return <PaperProvider theme={dark ? MD3DarkTheme : MD3LightTheme}>{children}</PaperProvider>;
}

const STATUS = {
  state: 'fixed' as const,
  freshness: 'live' as const,
  correction: 'ok' as const,
  reportedState: 'fixed' as const,
  correctionAgeS: 1,
  lastFixAtMs: NOW,
  sinceMs: NOW - 360_000,
};

/** A live RTK session whose caster declares no frame (RTK2go), project datum ITRF2020. */
function liveRtk(projectDatumId: string) {
  const d = defaultExtensionPrefs();
  useSettingsStore.setState({ extensions: { ...d, gnss: { ...d.gnss, installedAt: 1 } } });
  const profile = { ...newProfile('p', 'rtk2go'), label: 'RTK2go · LEVIS', mountpoint: 'LEVIS' };
  const config = {
    ...DEFAULT_GNSS_CONFIG,
    receiver: { id: 'r', name: 'RTK Facet', transport: 'ble' as const },
    profiles: [profile],
    activeProfileId: 'p',
    projectDatumId,
  };
  const fix = fixOf('rtk-fixed', { timeMs: NOW });
  const out = new FixOutputs(liteEngine);
  useGnssStore.setState({
    hydrated: true,
    config,
    link: 'connected',
    status: STATUS,
    fix,
    use: 'external',
    phone: 'standby',
    map: { lat: fix.lat, lon: fix.lon, result: out.onMap(fix, null, NOW) },
    project: out.inProject(fix, null, projectDatumOption(projectDatumId).datum, NOW),
    ntrip: { phase: 'streaming', message: null, bytes: 1000, lastDataAtMs: NOW },
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  useSettingsStore.setState({ extensions: defaultExtensionPrefs() });
  useGnssStore.setState({ config: DEFAULT_GNSS_CONFIG });
  useGnssStore.getState().resetLive();
});
afterEach(() => jest.useRealTimers());

describe('the receiver on the map', () => {
  it('chip → sheet: state, accuracies, corrections, the position with its method, ⚠ frame unknown', async () => {
    liveRtk('itrf2020');
    await render(wrap(<ReceiverMapOverlay top={0} showChip />));
    const chip = screen.getByTestId('gnss-receiver-chip');
    expect(screen.getByText('RTK fixed · ±1.4 cm')).toBeTruthy();
    expect(screen.getByText('14 sats · corr 1 s')).toBeTruthy();
    await fireEvent.press(chip);
    expect(screen.getByTestId('gnss-receiver-sheet')).toBeTruthy();
    expect(screen.getByText('RTK Facet')).toBeTruthy();
    expect(screen.getByText('Your location · phone GPS in standby')).toBeTruthy();
    expect(screen.getByText('RTK fixed for 6 min')).toBeTruthy();
    expect(screen.getByText('14 of 28 satellites')).toBeTruthy();
    expect(screen.getByLabelText('Horizontal accuracy ±1.4 cm')).toBeTruthy();
    expect(screen.getByLabelText('Vertical accuracy ±2.6 cm')).toBeTruthy();
    expect(screen.getByText('RTK2go · LEVIS')).toBeTruthy();
    expect(screen.getByText(/RTCM 3 over the phone’s data · age 1 s/)).toBeTruthy();
    // The project datum: ITRF2020 at the observation epoch, via the WGS 84 ensemble (2 m).
    expect(screen.getByText('46.800000° N, 71.200000° W')).toBeTruthy();
    expect(screen.getByText(/^Method: WGS 84 → ITRF2020 @ 2026\.77/)).toBeTruthy();
    expect(
      screen.getByText(/Stated accuracy: ±2\.0 m \(receiver ±1\.4 cm, conversion ±2\.0 m\)/),
    ).toBeTruthy();
    expect(screen.getByText(/^Frame unknown/)).toBeTruthy();
    expect(screen.getByText('As received')).toBeTruthy();
    await fireEvent.press(screen.getByText('Receiver settings'));
    expect(mockPush).toHaveBeenCalledWith('/settings');
    expect(useGnssStore.getState().sheetOpen).toBe(false);
  });

  it('a refused conversion is shown, not worked around; dark theme renders too', async () => {
    liveRtk('nad83-2011');
    await act(async () => useGnssStore.setState({ sheetOpen: true }));
    await render(wrap(<ReceiverMapOverlay top={0} showChip={false} />, true));
    expect(screen.queryByTestId('gnss-receiver-chip')).toBeNull();
    expect(screen.getByText('Not converted to NAD83(2011)')).toBeTruthy();
    expect(
      screen.getByText(/No validated conversion between ITRF2020 and NAD83\(2011\)/),
    ).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Close'));
    expect(useGnssStore.getState().sheetOpen).toBe(false);
  });

  it('nothing at all while no receiver is in use', async () => {
    await render(wrap(<ReceiverMapOverlay top={0} showChip />));
    expect(screen.queryByTestId('gnss-receiver-chip')).toBeNull();
  });
});

/** Native PROJ's stand-in: a fixed small shift (the real values are gated in core/gnss). */
const shifting: Engine = {
  kind: 'native',
  transform: (req) => ({
    ok: true,
    coords: req.coords.slice(0, req.dim).map((v, i) => v + ([0.00001, 0.00001, -0.3][i] ?? 0)),
  }),
};

describe('a project datum waiting for a grid (CGVD2013 heights)', () => {
  const MRNF = { frame: 'csrs' as const, epoch: 1997 };

  function waitingForGrid(): string[] {
    liveRtk('csrs-2010-cgvd2013');
    const fix = fixOf('rtk-fixed', { timeMs: NOW });
    const out = new FixOutputs(shifting);
    const datum = projectDatumOption('csrs-2010-cgvd2013').datum;
    const project = out.inProject(fix, MRNF, datum, NOW);
    useGnssStore.setState({
      config: {
        ...useGnssStore.getState().config,
        profiles: [{ ...newProfile('p', null), label: 'MRNF', mountpoint: 'LEVI', frame: MRNF }],
      },
      project,
      projectFallback: out.inFallback(fix, MRNF, datum, NOW),
      sheetOpen: true,
    });
    return project.ok ? [] : (project.refusal.grids ?? []);
  }

  it('amber "needs a download", one tap to Convert’s pack with progress, and meanwhile the ellipsoidal position', async () => {
    const grids = waitingForGrid();
    expect(grids.length).toBeGreaterThan(0);
    const pack = {
      id: 'qc-geoid',
      name: 'Québec heights',
      bbox: [-80, 44, -57, 63] as [number, number, number, number],
      bytes: 12_400_000,
      files: grids.map((name) => ({
        name,
        bytes: 12_400_000,
        md5: '',
        sha256: '',
        crop: null,
        source: 'PROJ-data 1.24',
        licence: 'OGL-Canada',
      })),
    };
    jest.mocked(packIndex).mockResolvedValue({ version: 1, generated: '', packs: [pack] });
    let finish: () => void = () => undefined;
    jest.mocked(installPack).mockImplementation(async (_p, progress) => {
      progress?.(6_200_000, 12_400_000);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    await render(wrap(<ReceiverMapOverlay top={0} showChip={false} />));
    expect(screen.getByText(/^Not yet in NAD83\(CSRS\) epoch 2010\.0/)).toBeTruthy();
    expect(screen.queryByText(/^Not converted/)).toBeNull();
    expect(screen.getByText(/Needs the .* grid on this device/)).toBeTruthy();
    expect(
      screen.getByText('Meanwhile, in NAD83(CSRS) 2010.0 with ellipsoidal heights:'),
    ).toBeTruthy();
    expect(
      screen.getByText(/^Method: NAD83\(CSRS\) 1997\.0 → NAD83\(CSRS\) 2010\.0$/),
    ).toBeTruthy();
    const button = await screen.findByText('Download Québec heights (12 MB)');
    const before = useConvertStore.getState().gridsVersion;
    await fireEvent.press(button);
    expect(screen.getByText(/Downloading… 6\.2 MB of 12 MB/)).toBeTruthy();
    await act(async () => finish());
    expect(installPack).toHaveBeenCalledWith(pack, expect.any(Function));
    expect(useConvertStore.getState().gridsVersion).toBe(before + 1);
  });

  it('offline, or a failed download, says so', async () => {
    waitingForGrid();
    jest.mocked(packIndex).mockResolvedValue(null);
    const { unmount } = await render(wrap(<ReceiverMapOverlay top={0} showChip={false} />, true));
    expect(await screen.findByText(/Connect to the internet to download it/)).toBeTruthy();
    await unmount();
    jest.mocked(packIndex).mockResolvedValue({ version: 1, generated: '', packs: [] });
    await render(wrap(<ReceiverMapOverlay top={0} showChip={false} />));
    expect(await screen.findByText(/No download covers this area/)).toBeTruthy();
  });
});

describe('ReceiverChipView', () => {
  it.each([false, true])('renders every tone (dark: %s), words first', async (dark) => {
    const base = {
      link: 'connected' as const,
      fix: fixOf('rtk-fixed'),
      using: 'external' as const,
      phoneAccuracyM: 5,
      fallback: false,
      nowMs: NOW,
    };
    const chips = [
      receiverChip({ ...base, status: STATUS }),
      receiverChip({ ...base, status: { ...STATUS, state: 'float' } }),
      receiverChip({ ...base, status: { ...STATUS, state: 'dgps' } }),
      receiverChip({ ...base, status: { ...STATUS, state: 'autonomous' } }),
      receiverChip({ ...base, status: null }),
    ];
    for (const variant of ['surface', 'chrome'] as const) {
      await render(
        wrap(
          <>
            {chips.map((c) => (
              <ReceiverChipView key={c.label} chip={c} variant={variant} />
            ))}
          </>,
          dark,
        ),
      );
      expect(screen.getByText('Receiver lost')).toBeTruthy();
      expect(screen.getByLabelText('RTK float · ±1.4 cm, 14 sats · corr 1 s')).toBeTruthy();
    }
  });

  it('totalAccuracy is the root-sum-square, or not stated', () => {
    expect(totalAccuracy(0.03, 0.04)).toBeCloseTo(0.05, 10);
    expect(totalAccuracy(null, 1)).toBeNull();
    expect(totalAccuracy(1, null)).toBeNull();
  });
});
