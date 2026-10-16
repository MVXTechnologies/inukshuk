import type { TrackPhoto } from '@core/photos/model';
import { useLibraryStore } from '@state/libraryStore';
import { useRecorderStore } from '@state/recorderStore';
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

// #741 — a note's photo (the Charts photo lane lists them) and a photo of
// the recording in progress (its circle on the live map) open the same card.
describe('note and recording photos (#741)', () => {
  afterEach(() => {
    useLibraryStore.setState({ tracks: [] });
    useRecorderStore.setState({ photos: [] });
  });

  it('shows a note photo with the note text and where it is on the trail', async () => {
    useLibraryStore.setState({
      tracks: [
        {
          id: 't1',
          name: 'Loop',
          startedAt: 0,
          stats: {},
          fileUri: 'file:///t1.gpx',
          notes: [
            {
              id: 'n2',
              distanceM: 2400,
              text: 'Viewpoint over Lac Bleu',
              createdAt: 0,
              photoUri: 'file:///doc/photos/n2.jpg',
            },
          ],
        } as never,
      ],
    });
    usePhotoCard.getState().show({ kind: 'own', trackId: 't1', photoId: 'note:n2' });
    await render(
      <PaperProvider>
        <PhotoBottomCard />
      </PaperProvider>,
    );
    expect(screen.getByText('Viewpoint over Lac Bleu')).toBeTruthy();
    expect(screen.getByText(/km 2\.4/)).toBeTruthy();
    expect(screen.getByTestId('photo-card-image').props.source).toEqual({
      uri: 'file:///doc/photos/n2.jpg',
    });
    // Read-only here: the note is edited from its own card.
    expect(screen.queryByTestId('photo-card-caption')).toBeNull();
    expect(screen.queryByTestId('photo-card-remove')).toBeNull();
  });

  it('shows a recording photo: number, time, distance; Share and Remove only', async () => {
    const pending = (id: string, distanceM: number) => ({
      id,
      takenAt: new Date(2026, 9, 12, 10, 42).getTime(),
      lngLat: [-71, 47] as [number, number],
      distanceM,
      file: `photos/s1/${id}.jpg`,
      thumb: `photos/s1/${id}.sq.jpg`,
      sprite: `photos/s1/${id}.map2.png`,
      width: 1,
      height: 1,
      bytes: 1,
    });
    const removeRec = jest.fn();
    useRecorderStore.setState({
      photos: [pending('r1', 800), pending('r2', 1600), pending('r3', 2400)],
      removePhoto: removeRec,
    } as never);
    usePhotoCard.getState().show({ kind: 'recording', photoId: 'r3' });
    await render(
      <PaperProvider>
        <PhotoBottomCard />
      </PaperProvider>,
    );
    expect(screen.getByText('Photo 3')).toBeTruthy();
    expect(screen.getByText(/km 2\.4/)).toBeTruthy();
    expect(screen.getByTestId('photo-card-image').props.source).toEqual({
      uri: 'file:///doc/photos/s1/r3.sq.jpg',
    });
    expect(screen.getByTestId('photo-card-share')).toBeTruthy();
    expect(screen.queryByTestId('photo-card-caption')).toBeNull();
    expect(screen.queryByTestId('photo-card-hide')).toBeNull();

    const alert = jest.spyOn(Alert, 'alert');
    await fireEvent.press(screen.getByTestId('photo-card-remove'));
    expect(alert.mock.calls.at(-1)?.[1]).toMatch(/from the recording\?/);
    const buttons = alert.mock.calls.at(-1)?.[2] ?? [];
    await act(async () => buttons.find((b) => b.text === 'Remove')?.onPress?.());
    expect(removeRec).toHaveBeenCalledWith('r3');
    expect(usePhotoCard.getState().target).toBeNull();
  });

  it('closes by itself once the recording photo is gone (saved, discarded)', async () => {
    useRecorderStore.setState({ photos: [] } as never);
    usePhotoCard.getState().show({ kind: 'recording', photoId: 'gone' });
    await render(
      <PaperProvider>
        <PhotoBottomCard />
      </PaperProvider>,
    );
    expect(screen.queryByTestId('photo-card')).toBeNull();
    expect(usePhotoCard.getState().target).toBeNull();
  });
});
