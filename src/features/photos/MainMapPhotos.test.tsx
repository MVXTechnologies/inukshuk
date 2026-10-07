import type { TrackSummary } from '@core/models';
import type { TrackPhoto } from '@core/photos/model';
import { useSettingsStore } from '@state/settingsStore';
import { useTrailPhotosStore } from '@state/trailPhotosStore';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';

import { MainMapPhotoChip, useMainMapPhotos } from './MainMapPhotos';

jest.mock('@data/storage', () => ({ writeJson: jest.fn(), readJson: async () => null }));
jest.mock('@data/photos/trailPhotos', () => ({
  readTrailPhotos: jest.fn(async () => ({ status: 'ok', photos: [] })),
  editTrailPhoto: jest.fn(),
  removeTrailPhoto: jest.fn(),
}));
jest.mock('@state/libraryStore', () => ({
  useLibraryStore: { getState: () => ({ hydrated: false, tracks: [] }) },
}));
jest.mock('./TrailPhotoLayers', () => ({ TrailPhotoLayers: () => null }));

const reads = (jest.requireMock('@data/photos/trailPhotos') as { readTrailPhotos: jest.Mock })
  .readTrailPhotos;

const track = (id: string, photoCount?: number): TrackSummary =>
  ({ id, name: `Trail ${id}`, ...(photoCount ? { photoCount } : {}) }) as TrackSummary;
const photo = (id: string) => ({ id, takenAt: 1, distanceM: 0 }) as TrackPhoto;

beforeEach(() => {
  reads.mockClear();
  useTrailPhotosStore.setState({ byTrack: {} });
  useSettingsStore.setState({ photosOnMainMap: true, photoCirclesAppear: 'zoomed' });
});

it('reads only shown trails that have photos, and labels them', async () => {
  useTrailPhotosStore.setState({
    byTrack: { a: { status: 'ok', photos: [photo('p1'), photo('p2')] } },
  });
  const tracks = [track('a', 2), track('b'), track('c', 4)];
  const { result } = await renderHook(() => useMainMapPhotos(['a', 'b'], tracks));
  await act(async () => undefined);
  expect(reads).not.toHaveBeenCalledWith('b');
  expect(reads).not.toHaveBeenCalledWith('c');
  expect(result.current.minZoom).toBe(12);
  expect(result.current.trails.map((t) => t.trackId)).toEqual(['a']);
  expect(result.current.label).toBe('Trail a · 2 photos');
  await act(async () => result.current.toggleHidden());
  expect(result.current.hidden).toBe(true);
});

it('is off when the setting says trail view only', async () => {
  useSettingsStore.setState({ photoCirclesAppear: 'trail' });
  const { result } = await renderHook(() => useMainMapPhotos(['a'], [track('a', 2)]));
  expect(result.current.minZoom).toBeNull();
  expect(result.current.trails).toEqual([]);
  expect(reads).not.toHaveBeenCalled();
});

it('the chip toggles the photos and says what it does', async () => {
  const onToggle = jest.fn();
  await render(
    <PaperProvider>
      <MainMapPhotoChip label="Lac des Cygnes · 33 photos" hidden={false} onToggle={onToggle} />
    </PaperProvider>,
  );
  const chip = screen.getByLabelText('Lac des Cygnes · 33 photos. Hide photos on the map');
  fireEvent.press(chip);
  expect(onToggle).toHaveBeenCalled();
});
