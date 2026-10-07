/**
 * Settings → Extensions: one-line rows, collapsed by default, that expand to
 * their details one at a time; Get and the switch work without expanding; a
 * deep link (`?open=extensions&ext=<key>`) opens that extension.
 */
import type { OfflineRegion } from '@data/offline';
import { extensionSettingsHref } from '@features/extensions/expansion';
import { setExtensionsForTest } from '@features/map/extensionStyles.testUtils';
import { useExtensionSyncStore } from '@state/extensionSyncStore';
import { useGeodeticStore } from '@state/geodeticStore';
import { useOfflineStore } from '@state/offlineStore';
import { useSettingsStore } from '@state/settingsStore';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';

import { ExtensionsSection } from './ExtensionsSection';

jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@data/offline', () => ({
  listCompanionPacks: jest.fn(async () => []),
  listRegionPacks: jest.fn(async () => []),
  deleteCompanionPacks: jest.fn(async () => undefined),
  createRegionPack: jest.fn(async () => undefined),
}));

const NONE = {
  geoInstalled: false,
  geoOffline: true,
  geoShown: true,
  tidesInstalled: false,
  tidesShown: true,
};
const BOTH = { ...NONE, geoInstalled: true, tidesInstalled: true };

const row = (key: string) => screen.getByTestId(`extension-row-${key}`);
const expanded = (key: string) => row(key).props.accessibilityState?.expanded;
const prefs = () => useSettingsStore.getState().extensions;

async function renderSection(openExtension?: string) {
  await render(
    <PaperProvider>
      <ExtensionsSection openExtension={openExtension} />
    </PaperProvider>,
  );
}

beforeEach(() => {
  global.fetch = jest.fn(async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch;
  useSettingsStore.setState({ hydrated: true });
  useGeodeticStore.setState({ coverage: null });
  useExtensionSyncStore.setState({ byKey: {} });
  useOfflineStore.setState({ regions: [] });
});

describe('collapsed by default', () => {
  it('shows each extension as one row: name, one-line summary, Get — no details', async () => {
    setExtensionsForTest(NONE);
    await renderSection();
    expect(expanded('geodetic')).toBe(false);
    expect(expanded('tides')).toBe(false);
    const summary = screen.getByText('Survey marks and benchmarks');
    expect(summary.props.numberOfLines).toBe(1);
    expect(screen.getByText('Tide gauges and tidal levels').props.numberOfLines).toBe(1);
    expect(screen.getByLabelText('Get Geodetic points')).toBeTruthy();
    expect(screen.getByLabelText('Get Tide stations')).toBeTruthy();
    expect(screen.queryByTestId('extension-details-geodetic')).toBeNull();
    expect(screen.queryByText(/^Every known survey mark/)).toBeNull();
  });

  it('installed, the switch takes Get’s place; options and Remove stay folded', async () => {
    setExtensionsForTest(BOTH);
    await renderSection();
    expect(screen.getByLabelText('Show geodetic points')).toBeTruthy();
    expect(screen.getByLabelText('Show tide stations')).toBeTruthy();
    expect(screen.queryByText('Offline in your regions')).toBeNull();
    expect(screen.queryByLabelText('Remove Geodetic points extension')).toBeNull();
  });
});

describe('the primary control works without expanding', () => {
  it('Get installs from the collapsed row, which stays collapsed', async () => {
    setExtensionsForTest(NONE);
    await renderSection();
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Get Tide stations'));
    });
    expect(prefs().tides.installedAt).toBeGreaterThan(0);
    expect(screen.getByLabelText('Show tide stations')).toBeTruthy();
    expect(expanded('tides')).toBe(false);
  });

  it('the switch turns the layer off and on from the collapsed row', async () => {
    setExtensionsForTest(BOTH);
    await renderSection();
    await act(async () => {
      fireEvent(screen.getByLabelText('Show geodetic points'), 'valueChange', false);
    });
    expect(prefs().geodetic.show).toBe(false);
    expect(expanded('geodetic')).toBe(false);
    await act(async () => {
      fireEvent(screen.getByLabelText('Show geodetic points'), 'valueChange', true);
    });
    expect(prefs().geodetic.show).toBe(true);
  });

  it('the control is its own element, not folded into the row button', async () => {
    setExtensionsForTest(BOTH);
    await renderSection();
    expect(within(row('geodetic')).queryByLabelText('Show geodetic points')).toBeNull();
    expect(row('geodetic').props.accessibilityRole).toBe('button');
    expect(row('geodetic').props.accessibilityLabel).toBe(
      'Geodetic points, Survey marks and benchmarks',
    );
  });
});

describe('expanding', () => {
  it('a tap on the row shows the details; another hides them', async () => {
    setExtensionsForTest(BOTH);
    await renderSection();
    await act(async () => {
      fireEvent.press(row('geodetic'));
    });
    expect(expanded('geodetic')).toBe(true);
    expect(screen.getByText(/^Every known survey mark/)).toBeTruthy();
    expect(screen.getByText('Offline in your regions')).toBeTruthy();
    expect(screen.getByLabelText('Coverage & sources')).toBeTruthy();
    expect(screen.getByLabelText('Remove Geodetic points extension')).toBeTruthy();
    expect(screen.getByLabelText('Geodetic points legend')).toBeTruthy();
    await act(async () => {
      fireEvent.press(row('geodetic'));
    });
    expect(expanded('geodetic')).toBe(false);
    expect(screen.queryByText('Offline in your regions')).toBeNull();
  });

  it('before the install, the details are what it is, its legend and its note', async () => {
    setExtensionsForTest(NONE);
    await renderSection();
    await act(async () => {
      fireEvent.press(row('tides'));
    });
    expect(screen.getByText(/^Tide gauges with their published tidal levels/)).toBeTruthy();
    expect(screen.getByLabelText('Gauge symbols legend')).toBeTruthy();
    expect(screen.getByText(/^Free · a few kB per offline region/)).toBeTruthy();
    expect(screen.queryByLabelText('Remove Tide stations extension')).toBeNull();
  });

  it('one at a time: opening another closes the first', async () => {
    setExtensionsForTest(BOTH);
    await renderSection();
    await act(async () => {
      fireEvent.press(row('geodetic'));
    });
    await act(async () => {
      fireEvent.press(row('tides'));
    });
    expect(expanded('tides')).toBe(true);
    expect(expanded('geodetic')).toBe(false);
    expect(screen.getByLabelText('Tide coverage & sources')).toBeTruthy();
    expect(screen.queryByLabelText('Coverage & sources')).toBeNull();
  });
});

describe('deep links', () => {
  it('open the named extension, the others collapsed', async () => {
    setExtensionsForTest(BOTH);
    await renderSection('tides');
    expect(expanded('tides')).toBe(true);
    expect(expanded('geodetic')).toBe(false);
    expect(screen.getByLabelText('Remove Tide stations extension')).toBeTruthy();
  });

  it('ignore an unknown key', async () => {
    setExtensionsForTest(BOTH);
    await renderSection('nope');
    expect(expanded('tides')).toBe(false);
    expect(expanded('geodetic')).toBe(false);
  });

  it('are built by extensionSettingsHref', () => {
    expect(extensionSettingsHref('tides')).toEqual({
      pathname: '/settings',
      params: { open: 'extensions', ext: 'tides' },
    });
  });
});

it('geodetic’s row says when the marks are in the offline regions', async () => {
  setExtensionsForTest(BOTH);
  const region: OfflineRegion = {
    id: 'r1',
    packId: 'p1',
    label: 'Charlevoix',
    basemap: 'map',
    bounds: { minLat: 47, minLng: -71, maxLat: 48, maxLng: -70 },
    sizeBytes: 1,
    complete: true,
    format: 'vector',
    includes: ['geodetic'],
  };
  useOfflineStore.setState({ regions: [region] });
  await renderSection();
  expect(screen.getByText('Offline ✓')).toBeTruthy();
  expect(row('geodetic').props.accessibilityLabel).toBe(
    'Geodetic points, Offline ✓, Survey marks and benchmarks',
  );
});
