import { DEFAULT_GNSS_CONFIG, newProfile } from '@core/gnss/config';
import { defaultExtensionPrefs } from '@core/extensions/prefs';
import { fixOf } from '@core/gnss/testUtils';
import { ExtensionsSection } from '@features/settings/ExtensionsSection';
import { useGnssStore } from '@state/gnssStore';
import { useSettingsStore } from '@state/settingsStore';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { MD3DarkTheme, MD3LightTheme, PaperProvider } from 'react-native-paper';

import { GnssCorrectionsScreen } from './GnssCorrectionsScreen';
import { GnssDatumScreen } from './GnssDatumScreen';
import { GnssPairScreen } from './GnssPairScreen';

const mockPush = jest.fn();
const mockBack = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush, back: mockBack }) }));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));
jest.mock('@data/storage', () => ({
  newId: () => 'new-id',
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
  deleteFileAt: jest.fn(),
}));
jest.mock('@data/offline', () => ({
  listCompanionPacks: jest.fn(async () => []),
  listRegionPacks: jest.fn(async () => []),
  deleteCompanionPacks: jest.fn(async () => undefined),
  createRegionPack: jest.fn(async () => undefined),
}));
jest.mock('@lib/nativeProj', () => ({ nativeEngine: () => null, initNativeProj: jest.fn() }));

function wrap(children: ReactNode, dark = false) {
  return <PaperProvider theme={dark ? MD3DarkTheme : MD3LightTheme}>{children}</PaperProvider>;
}

function setGnss(installedAt: number) {
  const d = defaultExtensionPrefs();
  useSettingsStore.setState({ extensions: { ...d, gnss: { ...d.gnss, installedAt } } });
}

beforeEach(() => {
  mockPush.mockReset();
  mockBack.mockReset();
  useGnssStore.setState({ hydrated: true, config: DEFAULT_GNSS_CONFIG });
  useGnssStore.getState().resetLive();
});

describe('Settings → Extensions: External GNSS receiver', () => {
  it('is offered (this build can reach a receiver) and Get installs it', async () => {
    setGnss(0);
    await render(wrap(<ExtensionsSection />));
    expect(screen.getByText('External GNSS receiver')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Get External GNSS receiver'));
    expect(useSettingsStore.getState().extensions.gnss.installedAt).toBeGreaterThan(0);
    expect(screen.getByText('Receiver')).toBeTruthy();
    expect(screen.getByText('None yet — connect one')).toBeTruthy();
  });

  it('installed: receiver, corrections, datum and the phone policy, in both themes', async () => {
    setGnss(1);
    useGnssStore.setState({
      config: {
        ...DEFAULT_GNSS_CONFIG,
        receiver: { id: 'r', name: 'RTK Facet', transport: 'ble' },
        profiles: [{ ...newProfile('p', 'rtk2go'), label: 'RTK2go · LEVIS', mountpoint: 'LEVIS' }],
        activeProfileId: 'p',
        projectDatumId: 'csrs-1997',
      },
      link: 'connected',
      status: {
        state: 'fixed',
        freshness: 'live',
        correction: 'ok',
        reportedState: 'fixed',
        correctionAgeS: 1,
        lastFixAtMs: 1,
        sinceMs: 1,
      },
      ntrip: { phase: 'streaming', message: null, bytes: 10, lastDataAtMs: 1 },
    });
    for (const dark of [false, true]) {
      const { unmount } = await render(wrap(<ExtensionsSection />, dark));
      expect(screen.getByText('RTK Facet · connected · RTK fixed')).toBeTruthy();
      expect(screen.getByText('RTK2go · LEVIS · LEVIS · streaming')).toBeTruthy();
      expect(screen.getByText(/NAD83\(CSRS\) epoch 1997\.0/)).toBeTruthy();
      await fireEvent(screen.getByLabelText('Phone GPS in standby'), 'valueChange', false);
      expect(useGnssStore.getState().config.phoneWhileGood).toBe('off');
      await fireEvent(
        screen.getByLabelText('Use the phone GPS when the receiver drops'),
        'valueChange',
        false,
      );
      expect(useGnssStore.getState().config.fallbackToPhone).toBe(false);
      await act(async () => {
        useGnssStore.getState().updateConfig({ phoneWhileGood: 'standby', fallbackToPhone: true });
      });
      await fireEvent.press(screen.getByTestId('gnss-receiver-row'));
      expect(mockPush).toHaveBeenLastCalledWith('/gnss/pair');
      await unmount();
    }
  });
});

describe('the receiver sub-screens', () => {
  it('pairing lists the simulated receiver and connecting saves it', async () => {
    jest.useFakeTimers();
    await render(wrap(<GnssPairScreen />));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(500);
    });
    await fireEvent.press(await screen.findByLabelText('Connect Simulated RTK receiver'));
    expect(useGnssStore.getState().config.receiver).toEqual({
      id: 'inukshuk-simulated-receiver',
      name: 'Simulated RTK receiver',
      transport: 'fake',
    });
    expect(mockBack).toHaveBeenCalled();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2000);
    });
    jest.useRealTimers();
  });

  it('project datum: each option says whether Convert can get there from the fix', async () => {
    useGnssStore.setState({ fix: fixOf('autonomous', { timeMs: Date.UTC(2026, 9, 7) }) });
    await render(wrap(<GnssDatumScreen />));
    expect(screen.getAllByText(/^WGS 84 → ITRF2020/).length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        /^Not from here: No validated conversion between ITRF2020 and NAD83\(2011\)/,
      ),
    ).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('NAD83(CSRS) epoch 1997.0'));
    expect(useGnssStore.getState().config.projectDatumId).toBe('csrs-1997');
  });

  it('corrections: unknown frame warns; saving keeps the password out of the profile', async () => {
    await render(wrap(<GnssCorrectionsScreen />));
    expect(screen.getByText(/doesn’t say which datum its bases use/)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Save and use'));
    expect(await screen.findByText('Choose a mountpoint')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('gnss-mountpoint'), 'SIM_LEVIS');
    await fireEvent.changeText(screen.getByTestId('gnss-password'), 'secret');
    await fireEvent.press(screen.getByLabelText('Save and use'));
    await screen.findByLabelText('Save and use');
    const { config } = useGnssStore.getState();
    expect(config.activeProfileId).toBe('new-id');
    expect(JSON.stringify(config)).not.toContain('secret');
  });
});
