/** Settings › Photos (#587): switches persist, usage shows, delete-all clears everything. */
import { useSettingsStore } from '@state/settingsStore';
import { act, fireEvent, render, type RenderResult } from '@testing-library/react-native';
import { InteractionManager } from 'react-native';
import { PaperProvider } from 'react-native-paper';

import { PhotosSection } from './PhotosSection';

jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
}));
jest.mock('@data/photos/photoFiles', () => ({
  photoStorageUsage: jest.fn(() => ({ photos: 33, trails: 2, bytes: 19e6 })),
  deleteAllTrailPhotos: jest.fn(() => 2),
}));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));
const mockForgetAll = jest.fn();
jest.mock('@state/trailPhotosStore', () => ({
  useTrailPhotosStore: { getState: () => ({ forgetAll: mockForgetAll }) },
}));
const mockClear = jest.fn();
jest.mock('@state/libraryStore', () => ({
  useLibraryStore: { getState: () => ({ clearTrackPhotoSummaries: mockClear }) },
}));

const files = jest.requireMock('@data/photos/photoFiles') as {
  photoStorageUsage: jest.Mock;
  deleteAllTrailPhotos: jest.Mock;
};

beforeAll(async () => {
  await useSettingsStore.getState().hydrate();
});

beforeEach(() => {
  jest.spyOn(InteractionManager, 'runAfterInteractions').mockImplementation((task?: unknown) => {
    if (typeof task === 'function') (task as () => void)();
    return { then: jest.fn(), done: jest.fn(), cancel: jest.fn() } as never;
  });
});

afterEach(() => {
  useSettingsStore.getState().reset();
  jest.restoreAllMocks();
});

const showSnack = jest.fn();

function renderSection(): Promise<RenderResult> {
  return render(
    <PaperProvider>
      <PhotosSection showSnack={showSnack} />
    </PaperProvider>,
  );
}

it('leads with the privacy promise and shows the storage used', async () => {
  const r = await renderSection();
  expect(r.getByText(/Your photos never leave this phone/)).toBeTruthy();
  expect(r.getByText('33 photos on 2 trails · 19 MB')).toBeTruthy();
});

it('persists the switches and the choices', async () => {
  const r = await renderSection();
  await act(async () => {
    fireEvent(r.getByLabelText('Show photos on the main map'), 'valueChange', false);
    fireEvent(r.getByLabelText('Include photos when sharing a trail'), 'valueChange', true);
  });
  expect(useSettingsStore.getState().photosOnMainMap).toBe(false);
  expect(useSettingsStore.getState().includePhotosWhenSharing).toBe(true);
  await act(async () => {
    fireEvent.press(r.getByText('Trail view only'));
    fireEvent.press(r.getByText('Full size'));
  });
  expect(useSettingsStore.getState().photoCirclesAppear).toBe('trail');
  expect(useSettingsStore.getState().photoCopySize).toBe('full');
  expect(r.getByText(/full resolution/)).toBeTruthy();
});

it('deletes every copy after a confirmation, and forgets the counts', async () => {
  const r = await renderSection();
  await act(async () => {
    fireEvent.press(r.getByText('Delete all photo copies'));
  });
  expect(r.getByText(/Delete the 33 copies Inukshuk keeps/)).toBeTruthy();
  files.photoStorageUsage.mockReturnValue({ photos: 0, trails: 0, bytes: 0 });
  await act(async () => {
    fireEvent.press(r.getByText('Delete'));
  });
  expect(files.deleteAllTrailPhotos).toHaveBeenCalled();
  expect(mockForgetAll).toHaveBeenCalled();
  expect(mockClear).toHaveBeenCalled();
  expect(showSnack).toHaveBeenCalledWith('Photo copies deleted');
  expect(r.getByText('No photo copies yet')).toBeTruthy();
});

it('reports a failed delete', async () => {
  files.photoStorageUsage.mockReturnValue({ photos: 3, trails: 1, bytes: 1e6 });
  files.deleteAllTrailPhotos.mockImplementationOnce(() => {
    throw new Error('io');
  });
  const r = await renderSection();
  await act(async () => {
    fireEvent.press(r.getByText('Delete all photo copies'));
  });
  await act(async () => {
    fireEvent.press(r.getByText('Delete'));
  });
  expect(showSnack).toHaveBeenCalledWith('Could not delete every photo copy. Try again.');
});
