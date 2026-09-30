/**
 * Long-distance trails in Explore (#467): the landing section (hidden until
 * the index is in), the full list (activity chips, sort, sections) and the
 * trail page (stats, stages, Show on map, Download, topo sheets). Data and
 * the ranking rules come from `@core/trails` fixtures; MapLibre, the DEM and
 * the pack downloader are stubbed.
 */
import { sampleDetail, sampleIndex } from '@core/trails/__fixtures__/trails';
import { loadTrailDetail, loadTrailIndex } from '@data/longTrails';
import { resetLongTrailsStore, useLongTrailsStore } from '@state/longTrailsStore';
import { useMapStore } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import { act, fireEvent } from '@testing-library/react-native';

import {
  fixtureIndex,
  fixtureItem,
  mountWithProviders,
  seedCatalog,
  settle,
} from '../explore/exploreTestUtils';
import { LongTrailScreen } from './LongTrailScreen';
import { LongTrailsListScreen } from './LongTrailsListScreen';
import { LongTrailsSection } from './LongTrailsSection';
import { downloadTrail } from './trailDownload';

const mockPush = jest.fn();
const mockNavigate = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({
    navigate: mockNavigate,
    push: mockPush,
    back: jest.fn(),
    replace: jest.fn(),
  }),
}));
jest.mock('@data/longTrails', () => ({ loadTrailIndex: jest.fn(), loadTrailDetail: jest.fn() }));
jest.mock('@data/catalogCache', () => ({
  loadCatalogManifest: jest.fn(),
  loadCatalogShard: jest.fn(),
  loadCatalogSearchDigest: jest.fn(),
}));
jest.mock('@features/store/downloadCatalogItem', () => ({
  CatalogDownloadCanceled: class extends Error {},
  cancelCatalogDownload: jest.fn(),
  downloadCatalogItemToLibrary: jest.fn(),
}));
jest.mock('@state/offlineStore', () => ({
  useOfflineStore: (select: (s: { regions: unknown[]; progress: null }) => unknown) =>
    select({ regions: [], progress: null }),
}));
jest.mock('./TrailRouteMap', () => ({ TrailRouteMap: () => null }));
jest.mock('./useTrailClimb', () => ({
  useTrailClimb: () => ({ status: 'done', totalM: 1847, stagesM: [420, 510, null, 380] }),
}));
jest.mock('./trailDownload', () => ({
  downloadTrail: jest.fn(async () => null),
  planTrailDownload: () => ({ boxes: [{}, {}], tiles: 3000, bytes: 3_000_000, tooBig: false }),
  // The real rule: stages always; a stage-less trail only when ≤ 60 km.
  downloadable: (d: { stages: unknown[]; lengthKm: number }, stage: number | null) =>
    stage !== null || (d.stages.length === 0 && d.lengthKm <= 60),
  refusalMessage: () => 'refused',
  trailPacks: () => [],
  trailDownloadKey: (id: string, stage: number | null) => `${id}-${stage ?? 'all'}`,
}));

// The Caps de Charlevoix and Route Verte are near; the Long Trail and TMB far.
const CHARLEVOIX = { latitude: 47.25, longitude: -70.9 };

beforeEach(() => {
  resetLongTrailsStore();
  useMapStore.setState({ mapCenter: null, focusBounds: null });
  useSettingsStore.setState({ lastKnownPosition: CHARLEVOIX, units: 'metric', offlineOnly: false });
  (loadTrailIndex as jest.Mock).mockResolvedValue({ index: sampleIndex(), fromCache: false });
  (loadTrailDetail as jest.Mock).mockResolvedValue(sampleDetail(true));
  seedCatalog(fixtureIndex({ items: [] }), { items: [] });
  mockPush.mockReset();
  mockNavigate.mockReset();
});

describe('Explore section', () => {
  it('ranks the trails near you and opens them', async () => {
    const view = await mountWithProviders(<LongTrailsSection />);
    await settle();
    expect(view.getByText('Long-distance trails near you')).toBeTruthy();
    expect(view.getByText('Sentier des Caps de Charlevoix')).toBeTruthy();
    expect(view.getByText('Hiking · ≈43 km · 4 stages')).toBeTruthy();
    expect(view.getByText('Route Verte 5')).toBeTruthy();
    await fireEvent.press(view.getByLabelText('See all long-distance trails'));
    expect(mockPush).toHaveBeenCalledWith('/explore/trails');
    await fireEvent.press(view.getByText('Sentier des Caps de Charlevoix'));
    expect(mockPush).toHaveBeenCalledWith('/explore/trail/r8730405');
  });

  it('falls back to the popular list without any position', async () => {
    useSettingsStore.setState({ lastKnownPosition: null });
    const view = await mountWithProviders(<LongTrailsSection />);
    await settle();
    expect(view.getByText('Popular long-distance trails')).toBeTruthy();
    expect(view.getByText('Tour du Mont-Blanc')).toBeTruthy();
  });

  it('hides itself while the index is unreachable', async () => {
    (loadTrailIndex as jest.Mock).mockResolvedValue(null);
    const view = await mountWithProviders(<LongTrailsSection />);
    await settle();
    expect(useLongTrailsStore.getState().status).toBe('unavailable');
    expect(view.queryByText('Long-distance trails near you')).toBeNull();
    expect(view.queryByText('See all')).toBeNull();
  });
});

describe('All trails list', () => {
  it('groups popular-near-you, home countries, then other continents', async () => {
    const view = await mountWithProviders(<LongTrailsListScreen />);
    await settle();
    expect(view.getByText('POPULAR NEAR YOU')).toBeTruthy();
    expect(view.getByText('EUROPE')).toBeTruthy();
    expect(view.getByText('Hiking · France, Italy, Switzerland · ≈170 km')).toBeTruthy();
    expect(view.getByLabelText('Sort: Nearest first')).toBeTruthy();
  });

  it('filters by activity', async () => {
    const view = await mountWithProviders(<LongTrailsListScreen />);
    await settle();
    await fireEvent.press(view.getByLabelText('Cycling'));
    expect(view.getByText('Route Verte 5')).toBeTruthy();
    expect(view.queryByText('Tour du Mont-Blanc')).toBeNull();
    await fireEvent.press(view.getByLabelText('All'));
    expect(view.getByText('Tour du Mont-Blanc')).toBeTruthy();
  });

  it('offers a retry when the list is unavailable', async () => {
    (loadTrailIndex as jest.Mock).mockResolvedValue(null);
    const view = await mountWithProviders(<LongTrailsListScreen />);
    await settle();
    expect(view.getByText(/isn’t available right now/)).toBeTruthy();
    (loadTrailIndex as jest.Mock).mockResolvedValue({ index: sampleIndex(), fromCache: false });
    await fireEvent.press(view.getByText('Retry'));
    await settle();
    expect(view.getByText('POPULAR NEAR YOU')).toBeTruthy();
  });
});

describe('Trail page', () => {
  it('shows stats, stages, topo sheets and the attribution', async () => {
    seedCatalog(
      fixtureIndex({
        items: [
          fixtureItem('cantopo-021m', 'Baie-Saint-Paul', 47.2, -70.7, {
            kind: 'topo',
            scale: 50000,
          }),
        ],
      }),
      {
        items: [
          fixtureItem('cantopo-021m', 'Baie-Saint-Paul', 47.2, -70.7, {
            kind: 'topo',
            scale: 50000,
          }),
        ],
      },
    );
    const view = await mountWithProviders(<LongTrailScreen id="r8730405" />);
    await settle();
    expect(view.getByText('Sentier des Caps de Charlevoix')).toBeTruthy();
    expect(
      view.getByText('Hiking · Saint-Tite-des-Caps → Petite-Rivière-Saint-François'),
    ).toBeTruthy();
    expect(view.getByLabelText('Length: ≈43 km')).toBeTruthy();
    expect(view.getByLabelText('Stages: 4')).toBeTruthy();
    expect(view.getByLabelText('Climb: ≈1 850 m')).toBeTruthy();
    expect(view.getByText(/Download a stage below/)).toBeTruthy();
    expect(view.getByText('Étape 2')).toBeTruthy();
    expect(view.getByText('≈11 km · ≈510 m climb · 3 MB')).toBeTruthy();
    expect(view.getByText('1 NRCan sheet · 1:50 000')).toBeTruthy();
    expect(view.getByText(/Route from OpenStreetMap/)).toBeTruthy();
    expect(view.getByText('sentierdescaps.com')).toBeTruthy();
  });

  it('shows the trail on the map, framing it', async () => {
    useSettingsStore.setState({ lastKnownPosition: null });
    const view = await mountWithProviders(<LongTrailScreen id="r8730405" />);
    await settle();
    await fireEvent.press(view.getByText('Show on map'));
    const shown = useLongTrailsStore.getState().shown;
    expect(shown?.detail.id).toBe('r8730405');
    expect(shown?.stageIndex).toBe(0);
    expect(useMapStore.getState().followUser).toBe(false);
    expect(mockNavigate).toHaveBeenCalledWith('/');
    // The fit waits for the map tab to come up.
    expect(useMapStore.getState().focusBounds).toBeNull();
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)));
    expect(useMapStore.getState().focusBounds?.minLng).toBeCloseTo(-70.754, 3);
    // Framed clear of the name pill, the controls rail and the stage sheet.
    expect(useMapStore.getState().focusPadding?.right).toBeGreaterThanOrEqual(80);
  });

  it('opens a stage on the map', async () => {
    const view = await mountWithProviders(<LongTrailScreen id="r8730405" />);
    await settle();
    await fireEvent.press(view.getByLabelText(/^Stage 3, Étape 3/));
    expect(useLongTrailsStore.getState().shown?.stageIndex).toBe(2);
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)));
    expect(useMapStore.getState().focusBounds?.minLng).toBeCloseTo(-70.68, 3);
  });

  it('downloads stage by stage, with no whole-trail download', async () => {
    const view = await mountWithProviders(<LongTrailScreen id="r8730405" />);
    await settle();
    expect(view.queryByLabelText('Download')).toBeNull();
    expect(view.getByText(/Download a stage below/)).toBeTruthy();
    expect(view.getByText('≈11 km · ≈510 m climb · 3 MB')).toBeTruthy();
    await act(async () => {
      await fireEvent.press(view.getByLabelText('Download stage 2, Étape 2, 3 MB'));
    });
    await settle();
    expect(downloadTrail).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'r8730405' }),
      1,
      expect.anything(),
      expect.any(Function),
      expect.any(Function),
    );
    expect(view.getByText('Offline map ready — it works without signal')).toBeTruthy();
  });

  it('offers one download for a short trail without stages, a note for a long one', async () => {
    (loadTrailDetail as jest.Mock).mockResolvedValue(sampleDetail(false));
    const view = await mountWithProviders(<LongTrailScreen id="r8730405" />);
    await settle();
    await act(async () => {
      await fireEvent.press(view.getByLabelText('Download'));
    });
    await settle();
    expect(downloadTrail).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'r8730405' }),
      null,
      expect.anything(),
      expect.any(Function),
      expect.any(Function),
    );
    await view.unmount();

    (loadTrailDetail as jest.Mock).mockResolvedValue({ ...sampleDetail(false), lengthKm: 400 });
    resetLongTrailsStore();
    const long = await mountWithProviders(<LongTrailScreen id="r8730405" />);
    await settle();
    expect(long.queryByLabelText('Download')).toBeNull();
    expect(long.getByText(/download an area from the map instead/)).toBeTruthy();
  });

  it('hides the stages section for a stage-less trail', async () => {
    (loadTrailDetail as jest.Mock).mockResolvedValue(sampleDetail(false));
    const view = await mountWithProviders(<LongTrailScreen id="r8730405" />);
    await settle();
    expect(view.queryByText('Stages')).toBeNull();
    expect(view.queryByLabelText(/^Stages:/)).toBeNull();
  });

  it('says so when the trail is not in the index', async () => {
    (loadTrailDetail as jest.Mock).mockResolvedValue(null);
    const view = await mountWithProviders(<LongTrailScreen id="r1" />);
    await settle();
    expect(view.getByText('This trail isn’t available right now.')).toBeTruthy();
  });
});
