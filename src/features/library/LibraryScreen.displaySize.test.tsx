/**
 * The Library at every Display size (#760): every explicitly sized pressable
 * keeps a 48 dp touch target (with its hitSlop), Small included.
 */
import { DISPLAY_SCALES } from '@core/display/displayScale';
import type { TrackSummary } from '@core/models';
import { LibraryScreen } from '@features/library/LibraryScreen';
import { useLibraryStore } from '@state/libraryStore';
import { useSettingsStore } from '@state/settingsStore';
import { render, screen } from '@testing-library/react-native';
import { resolveTheme } from '@ui/theme';
import { pressableCount, smallTouchTargets } from '@ui/touchTargets.testUtils';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

jest.mock('expo-router', () => ({
  useIsFocused: () => true,
  useRouter: () => ({ navigate: jest.fn(), push: jest.fn() }),
}));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));
jest.mock('@data/storage', () => ({
  newId: () => 'id',
  deleteFileAt: jest.fn(),
  writeIndex: jest.fn(),
  writeJson: jest.fn(),
  readJson: async () => null,
  toDocumentPath: (uri: string) => uri,
  resolveDocumentPath: (path: string) => path,
  documentDirUri: () => 'file:///Documents',
  existingOverlayPng: () => null,
  fileSizeAt: () => 0,
}));
jest.mock('@features/library/importMap', () => ({ pickAndImportMaps: jest.fn() }));
jest.mock('@features/library/importActivities', () => ({
  pickAndImportActivityFiles: jest.fn(),
  activityImportMessage: jest.fn(),
}));
jest.mock('./useRouteThumbnail', () => ({ useRouteThumbnail: () => undefined }));

const track = (id: string, name: string): TrackSummary => ({
  id,
  name,
  fileUri: `file:///${id}.gpx`,
  startedAt: new Date(2026, 7, 29, 6).getTime(),
  stats: {
    distanceM: 11190,
    ascentM: 1068,
    descentM: 1050,
    durationS: 3 * 3600 + 31 * 60,
    movingTimeS: 0,
    avgSpeedMps: 0,
    maxSpeedMps: 0,
    pointCount: 10,
  },
});

async function show(k: number, empty = false) {
  useSettingsStore.setState({ displayScale: k as 1 });
  useLibraryStore.setState({
    hydrated: true,
    maps: [],
    tracks: empty ? [] : [track('t1', 'Mont Wright loop'), track('t2', 'Corridor du Littoral')],
    folders: [],
    waypoints: [],
    activeTrackIds: [],
    customCategories: [],
  });
  await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 360, height: 760 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <PaperProvider theme={resolveTheme('light', 'normal', k)}>
        <LibraryScreen />
      </PaperProvider>
    </SafeAreaProvider>,
  );
}

afterEach(() => useSettingsStore.getState().reset());

describe.each(DISPLAY_SCALES.map((k) => [k]))('Library at Display size %p', (k) => {
  it('every sized pressable keeps a 48 dp touch target', async () => {
    await show(k);
    expect(screen.getByText('Mont Wright loop')).toBeOnTheScreen();
    expect(pressableCount(screen.toJSON() as never)).toBeGreaterThan(5);
    expect(smallTouchTargets(screen.toJSON() as never)).toEqual([]);
  });

  it('the first-run state too', async () => {
    await show(k, true);
    expect(smallTouchTargets(screen.toJSON() as never)).toEqual([]);
  });
});
