import type { TrackPhoto } from '@core/photos/model';
import type { ViewerTrail } from '@core/photos/viewerInfo';
import { usePhotoFocusStore } from '@state/photoFocusStore';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { PhotoViewerScreen } from './PhotoViewerScreen';
import type { ViewerTrailData } from './useViewerTrail';

jest.mock('@data/storage', () => ({ resolveDocumentPath: (p: string) => `file:///doc/${p}` }));
jest.mock('@data/photos/trailPhotos', () => ({}));
const mockDispose = jest.fn();
jest.mock('./sharePhoto', () => ({
  ...jest.requireActual<object>('./sharePhoto'),
  shareablePhotoUri: jest.fn(async (p: { file: string }) => ({
    uri: `file:///doc/${p.file}`,
    dispose: mockDispose,
  })),
}));
const mockDismissTo = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({
    back: jest.fn(),
    canGoBack: () => true,
    replace: jest.fn(),
    dismissTo: mockDismissTo,
  }),
}));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: jest.fn(async () => undefined),
}));
const mockData: { current: ViewerTrailData } = { current: null as never };
jest.mock('./useViewerTrail', () => ({ useViewerTrail: () => mockData.current }));

const sharing = jest.requireMock('expo-sharing') as { shareAsync: jest.Mock };

const START = Date.UTC(2026, 8, 27, 13, 12);
const photo = (id: string, distanceM: number, extra: Partial<TrackPhoto> = {}): TrackPhoto =>
  ({
    id,
    trackId: 't1',
    distanceM,
    lngLat: [0, 0],
    placement: 'time',
    takenAt: START + distanceM * 1000,
    file: `photos/t1/${id}.jpg`,
    thumb: `photos/t1/${id}.sq.jpg`,
    sprite: `photos/t1/${id}.map.png`,
    width: 1,
    height: 1,
    bytes: 1,
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  }) as TrackPhoto;

const cum = Array.from({ length: 11 }, (_, i) => i * 1000);
const trail: ViewerTrail = {
  axisCumM: cum,
  elevations: cum.map((d) => 500 + d / 20),
  totalM: 10_000,
  startMs: START,
};

function seed(status: ViewerTrailData['status'], photos: TrackPhoto[]) {
  mockData.current = {
    track: { id: 't1', name: 'Mont du Lac des Cygnes' } as ViewerTrailData['track'],
    photos,
    status,
    trail,
    indexCumM: cum,
  };
}

const mount = (photoId: string) =>
  render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <PaperProvider>
        <PhotoViewerScreen trackId="t1" photoId={photoId} />
      </PaperProvider>
    </SafeAreaProvider>,
  );

it('shows where and when the photo was taken', async () => {
  seed('ok', [photo('a', 1000), photo('b', 3200, { caption: 'Lac des Cygnes appears' })]);
  await mount('b');
  expect(screen.getByTestId('photo-viewer-counter').props.children).toBe('2 of 2');
  expect(screen.getByText('Lac des Cygnes appears')).toBeTruthy();
  expect(screen.getByText('3.20 km')).toBeTruthy();
  expect(screen.getByText('of 10.00 km · going up')).toBeTruthy();
  expect(screen.getByText('660 m')).toBeTruthy();
  expect(screen.getByText('+160 m')).toBeTruthy();
  expect(screen.getByText(/53 min after the start/)).toBeTruthy();
  expect(screen.getByText('Placed on the trail by its time')).toBeTruthy();
});

it('shares the location-free copy and hands "Show on map" to the trail view', async () => {
  seed('ok', [photo('a', 1000)]);
  await mount('a');
  await fireEvent.press(screen.getByLabelText('Share photo'));
  expect(sharing.shareAsync).toHaveBeenCalledWith(
    'file:///doc/photos/t1/a.jpg',
    expect.objectContaining({ mimeType: 'image/jpeg' }),
  );
  // The checked (or re-stripped) copy is cleaned up after the share sheet.
  expect(mockDispose).toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText('Show on map'));
  expect(usePhotoFocusStore.getState().request).toEqual({ trackId: 't1', photoId: 'a' });
  expect(mockDismissTo).toHaveBeenCalledWith('/trail3d/t1');
});

it('blocks edits on a photo list from a newer version, and says so', async () => {
  seed('future', [photo('a', 1000)]);
  await mount('a');
  expect(screen.getByTestId('photo-notice')).toBeTruthy();
  expect(screen.getByLabelText('Caption')).toBeDisabled();
  expect(screen.getByLabelText('More photo actions')).toBeDisabled();
});

it('keeps note photos read-only and unshared', async () => {
  seed('ok', [photo('note:n1', 1000, { placement: 'manual', takenAt: undefined })]);
  await mount('note:n1');
  expect(screen.getByText('From a trail note')).toBeTruthy();
  expect(screen.getByLabelText('Caption')).toBeDisabled();
  expect(screen.getByLabelText('Share photo')).toBeDisabled();
});
