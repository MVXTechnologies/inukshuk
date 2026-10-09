import type { TrackPhoto } from '@core/photos/model';
import { useTrailPhotosStore } from '@state/trailPhotosStore';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { PhotoBottomCard, usePhotoCard } from './PhotoBottomCard';

jest.mock('@data/storage', () => ({
  resolveDocumentPath: (p: string) => `file:///doc/${p}`,
}));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: jest.fn(async () => undefined),
}));
jest.mock('./sharePhoto', () => ({
  shareablePhotoUri: jest.fn(async () => ({ uri: 'file:///tmp/s.jpg', dispose: jest.fn() })),
  UnshareablePhotoError: class extends Error {},
}));
jest.mock('@features/team/PhotoTeamComments', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    PhotoTeamComments: ({ photoId, all }: { photoId: string; all?: boolean }) => (
      <Text testID="comments">{`${photoId}:${all ? 'all' : 'some'}`}</Text>
    ),
  };
});

const photo = (over: Partial<TrackPhoto> = {}): TrackPhoto => ({
  id: 'p1',
  trackId: 't1',
  distanceM: 1500,
  lngLat: [-71, 47],
  placement: 'time',
  file: 'photos/t1/p1.jpg',
  thumb: 'photos/t1/p1.thumb.jpg',
  sprite: 'photos/t1/p1.map.png',
  width: 4000,
  height: 3000,
  bytes: 1,
  createdAt: 0,
  updatedAt: 0,
  caption: 'Summit',
  ...over,
});

const editPhoto = jest.fn(async () => undefined);
const removePhoto = jest.fn(async () => undefined);

async function mount() {
  useTrailPhotosStore.setState({
    byTrack: { t1: { status: 'ok', photos: [photo()] } },
    editPhoto,
    removePhoto,
  } as never);
  usePhotoCard.getState().show({ kind: 'own', trackId: 't1', photoId: 'p1' });
  await render(
    <PaperProvider>
      <PhotoBottomCard />
    </PaperProvider>,
  );
}

afterEach(() => usePhotoCard.getState().close());

describe('the photo card', () => {
  it('shows the photo and every team comment in the card itself (no full-screen view)', async () => {
    await mount();
    expect(screen.getByText('Summit')).toBeTruthy();
    expect(screen.getByText(/km 1\.5/)).toBeTruthy();
    expect(screen.getByTestId('comments').props.children).toBe('p1:all');
    expect(screen.queryByTestId('photo-card-full')).toBeNull();
    expect(screen.getByTestId('photo-card-scroll')).toBeTruthy();
  });

  it('closes from its close button', async () => {
    await mount();
    await fireEvent.press(screen.getByTestId('photo-card-close'));
    expect(usePhotoCard.getState().target).toBeNull();
  });

  it('captions, hides and removes my own photo from the card', async () => {
    await mount();
    await fireEvent.press(screen.getByTestId('photo-card-caption'));
    await fireEvent.changeText(screen.getByTestId('photo-card-caption-input'), 'Lichen glade');
    await act(async () => fireEvent.press(screen.getByTestId('photo-card-caption-save')));
    expect(editPhoto).toHaveBeenCalledWith('t1', 'p1', { caption: 'Lichen glade' });

    await act(async () => fireEvent.press(screen.getByTestId('photo-card-hide')));
    expect(editPhoto).toHaveBeenCalledWith('t1', 'p1', { hidden: true });

    const alert = jest.spyOn(Alert, 'alert');
    await fireEvent.press(screen.getByTestId('photo-card-remove'));
    const buttons = alert.mock.calls[0]?.[2] ?? [];
    await act(async () => buttons.find((b) => b.text === 'Remove')?.onPress?.());
    expect(removePhoto).toHaveBeenCalledWith('t1', 'p1');
    expect(usePhotoCard.getState().target).toBeNull();
  });
});
