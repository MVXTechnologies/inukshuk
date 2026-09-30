/**
 * A long-distance trail on the main map (#467, board `OnMap.dc.html`): the
 * pill closes it, the sheet names the selected stage with its length, climb
 * and your distance, steps through stages (re-framing the map), frames the
 * stage and opens the trail page.
 */
import { sampleDetail } from '@core/trails/__fixtures__/trails';
import { resetLongTrailsStore, useLongTrailsStore } from '@state/longTrailsStore';
import { useMapStore } from '@state/mapStore';
import { fireEvent, render } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';

import { ShownTrailPill, ShownTrailSheet } from './ShownTrailChrome';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ navigate: jest.fn(), push: mockPush, back: jest.fn(), replace: jest.fn() }),
}));
jest.mock('@state/offlineStore', () => ({
  useOfflineStore: (select: (s: { regions: unknown[]; progress: null }) => unknown) =>
    select({ regions: [], progress: null }),
}));
jest.mock('@features/store/trails/trailDownload', () => ({
  downloadTrail: jest.fn(async () => null),
  planTrailDownload: () => ({ boxes: [{}], tiles: 100, bytes: 2_000_000, tooBig: false }),
  downloadable: () => true,
  refusalMessage: () => 'refused',
  trailPacks: () => [],
  trailDownloadKey: (id: string, stage: number | null) => `${id}-${stage ?? 'all'}`,
}));
const mockMessage = jest.fn();
jest.mock('@features/store/trails/useTrailClimb', () => ({
  useTrailClimb: () => ({ status: 'done', totalM: 1847, stagesM: [420, 510, null, 380] }),
}));

const detail = sampleDetail(true);

beforeEach(() => {
  resetLongTrailsStore();
  useMapStore.setState({ focusBounds: null });
  mockPush.mockReset();
});

async function sheet(stageIndex: number | null, position: [number, number] | null = null) {
  useLongTrailsStore.getState().show(detail, stageIndex);
  const shown = useLongTrailsStore.getState().shown!;
  return render(
    <PaperProvider>
      <ShownTrailSheet shown={shown} position={position} units="metric" onMessage={mockMessage} />
    </PaperProvider>,
  );
}

it('the pill names the trail and hides it', async () => {
  useLongTrailsStore.getState().show(detail, 0);
  const view = await render(
    <PaperProvider>
      <ShownTrailPill shown={useLongTrailsStore.getState().shown!} />
    </PaperProvider>,
  );
  expect(view.getByText('Sentier des Caps de Charlevoix')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('Hide trail'));
  expect(useLongTrailsStore.getState().shown).toBeNull();
});

it('describes the selected stage and how far you are from it', async () => {
  const view = await sheet(1, [-70.72, 47.2]);
  expect(view.getByText('Stage 2 · Étape 2')).toBeTruthy();
  expect(view.getByText(/≈11 km · ≈510 m climb · you are .* from it/)).toBeTruthy();
});

it('steps between stages and frames them', async () => {
  const view = await sheet(0);
  await fireEvent.press(view.getByLabelText('Next stage'));
  expect(useLongTrailsStore.getState().shown?.stageIndex).toBe(1);
  expect(useMapStore.getState().focusBounds?.minLng).toBeCloseTo(-70.72, 3);
  await fireEvent.press(view.getByText('Zoom to stage'));
  expect(useMapStore.getState().focusPadding?.right).toBeGreaterThanOrEqual(80);
  // The shown stage downloads from the sheet.
  await fireEvent.press(view.getByLabelText('Download stage 1, 2 MB'));
  await Promise.resolve();
  expect(
    jest.requireMock('@features/store/trails/trailDownload').downloadTrail,
  ).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'r8730405' }),
    0, // the stage this sheet was rendered for
    expect.anything(),
    expect.any(Function),
    expect.any(Function),
  );
  await fireEvent.press(view.getByText('Trail page'));
  expect(mockPush).toHaveBeenCalledWith('/explore/trail/r8730405');
});

it('works for a trail without stages', async () => {
  useLongTrailsStore.getState().show(sampleDetail(false), null);
  const view = await render(
    <PaperProvider>
      <ShownTrailSheet
        shown={useLongTrailsStore.getState().shown!}
        position={[-70.66, 47.22]}
        units="metric"
        onMessage={mockMessage}
      />
    </PaperProvider>,
  );
  expect(view.getByText('Sentier des Caps de Charlevoix')).toBeTruthy();
  expect(view.getByText(/850 m climb · you are on it$/)).toBeTruthy();
  expect(view.queryByLabelText('Next stage')).toBeNull();
  await fireEvent.press(view.getByText('Zoom to trail'));
  expect(useMapStore.getState().focusBounds?.maxLat).toBeCloseTo(47.312, 3);
});
