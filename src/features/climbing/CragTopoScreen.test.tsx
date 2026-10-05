/**
 * The topo screen on real fixture topos (`@core/climbing/__fixtures__`, built
 * by the NAS pipeline from OpenBeta + OSM): the wall diagram only where OSM
 * gives the order, the grade chart elsewhere, grades in the user's system,
 * access never "open" from missing data, the credits and the safety line.
 */
import fixtures from '@core/climbing/__fixtures__/crags.json';
import { parseCragDetail } from '@core/climbing/detail';
import { useClimbingStore } from '@state/climbingStore';
import { useSettingsStore } from '@state/settingsStore';
import { act, fireEvent, render } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { CragTopoScreen } from './CragTopoScreen';

const mockTopos: Record<string, unknown> = {
  [fixtures.Weir.uid]: fixtures.Weir,
  [fixtures['Lac Long'].uid]: fixtures['Lac Long'],
  [fixtures['Val-Bélair'].uid]: fixtures['Val-Bélair'],
};
jest.mock('@data/climbing', () => ({
  loadTopo: async (uid: string) => {
    const raw = mockTopos[uid];
    const { parseCragDetail: parse } = jest.requireActual('@core/climbing/detail');
    return raw ? { detail: parse(raw), raw, from: 'network' } : null;
  },
  attachmentUri: (p: string) => p,
  readClimbingDoc: async () => ({ schemaVersion: 1, saved: [] }),
  writeClimbingDoc: jest.fn(),
  loadCragIndex: async () => null,
}));
jest.mock('./climbingActions', () => ({
  CragDownloadError: class extends Error {},
  attachTopo: jest.fn(),
  downloadCrag: jest.fn(),
  estimateCragMap: () => 6_000_000,
  removeAttachment: jest.fn(),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), navigate: jest.fn(), push: jest.fn() }),
}));

async function open(uid: string) {
  const view = await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 400, height: 800 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <PaperProvider>
        <CragTopoScreen uid={uid} />
      </PaperProvider>
    </SafeAreaProvider>,
  );
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  return view;
}

beforeEach(() => {
  useSettingsStore.setState({
    climbingGradeSystem: 'auto',
    lastKnownPosition: { latitude: 46.8, longitude: -71.2 },
  });
  useClimbingStore.setState({ saved: [], downloads: {} });
});

it('draws the wall where OSM gives the order, in YDS in North America', async () => {
  const weir = parseCragDetail(fixtures.Weir)!;
  const view = await open(weir.uid);
  expect(view.getByText('Weir')).toBeTruthy();
  // The first sector (Club Sandwich) is ordered: the generated wall.
  expect(view.getByTestId('crag-wall-diagram')).toBeTruthy();
  expect(view.getByText('Generated · not to scale')).toBeTruthy();
  await fireEvent.press(view.getByText('Black and White · 28'));
  expect(await view.findByText("L'aiguillette 2")).toBeTruthy();
  // UIAA 4+ in OSM reads 5.5 for a YDS user, with where it came from.
  expect(view.getAllByText('5.5').length).toBeGreaterThan(0);
  expect(view.getByText(/UIAA 4\+ in OSM/)).toBeTruthy();
  // Access unknown in Québec: check FQME, never "open".
  expect(view.getByText('Access unknown · check FQME')).toBeTruthy();
  expect(view.queryByText(/Access open/)).toBeNull();
  expect(view.getByText('Routes: © OpenStreetMap contributors (ODbL)')).toBeTruthy();
  expect(view.getByText(/Route information can be wrong/)).toBeTruthy();
});

it('shows the grade chart, never a guessed wall, where the order is unknown', async () => {
  const view = await open(fixtures['Lac Long'].uid);
  expect(view.getByTestId('crag-grade-chart')).toBeTruthy();
  expect(view.queryByTestId('crag-wall-diagram')).toBeNull();
  expect(view.getByText('Wall order unknown')).toBeTruthy();
  expect(view.getByText('Routes: OpenBeta (CC0)')).toBeTruthy();
});

it('reads grades in French when asked', async () => {
  useSettingsStore.setState({ climbingGradeSystem: 'french' });
  const view = await open(fixtures['Lac Long'].uid);
  expect(view.getAllByText(/YDS 5\.\d/).length).toBeGreaterThan(0);
});

it('offers no download for a closed crag', async () => {
  const view = await open(fixtures['Val-Bélair'].uid);
  expect(view.getByText('Access closed')).toBeTruthy();
  expect(view.queryByTestId('crag-topo-download')).toBeNull();
});

it('says so when the topo is not on the phone and offline', async () => {
  const view = await open('ob-0000000000000000');
  expect(view.getByText(/This topo isn’t on your phone yet/)).toBeTruthy();
});
