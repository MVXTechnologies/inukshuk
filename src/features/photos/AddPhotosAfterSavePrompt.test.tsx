import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';

import {
  AddPhotosAfterSavePrompt,
  AFTER_STRAVA_DELAY_MS,
  PHOTO_PROMPT_MS,
} from './AddPhotosAfterSavePrompt';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

type Listener = (
  s: { lastSavedTrackId: string | null },
  p: { lastSavedTrackId: string | null },
) => void;
let mockListener: Listener | null = null;
jest.mock('@state/recorderStore', () => ({
  useRecorderStore: {
    subscribe: (l: Listener) => {
      mockListener = l;
      return () => {
        mockListener = null;
      };
    },
  },
}));
const mockSettings = { photoPromptAfterSaveShown: false, set: jest.fn() };
jest.mock('@state/settingsStore', () => ({
  useSettingsStore: { getState: () => mockSettings },
}));
let mockStrava: unknown = null;
jest.mock('@state/stravaStore', () => ({
  useStravaStore: { getState: () => ({ connection: mockStrava }) },
}));

const save = (id: string) =>
  act(() => mockListener?.({ lastSavedTrackId: id }, { lastSavedTrackId: null }));

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockSettings.photoPromptAfterSaveShown = false;
  mockSettings.set.mockImplementation((_k: string, v: boolean) => {
    mockSettings.photoPromptAfterSaveShown = v;
  });
  mockStrava = null;
});
afterEach(() => jest.useRealTimers());

async function mount() {
  await render(
    <PaperProvider>
      <AddPhotosAfterSavePrompt />
    </PaperProvider>,
  );
}

it('offers once after a save, and opens the trail with the sheet', async () => {
  await mount();
  await save('t1');
  await act(() => jest.advanceTimersByTime(0));
  expect(screen.getByText('Add photos from this outing?')).toBeOnTheScreen();
  expect(mockSettings.set).toHaveBeenCalledWith('photoPromptAfterSaveShown', true);
  await fireEvent.press(screen.getByText('Add photos'));
  expect(mockPush).toHaveBeenCalledWith('/trail3d/t1?addPhotos=1');
  // A later save is not asked about again.
  await save('t2');
  await act(() => jest.advanceTimersByTime(0));
  expect(mockSettings.set).toHaveBeenCalledTimes(1);
  expect(mockPush).toHaveBeenCalledTimes(1);
});

it('goes away on its own', async () => {
  await mount();
  await save('t1');
  await act(() => jest.advanceTimersByTime(PHOTO_PROMPT_MS + 1));
  expect(mockPush).not.toHaveBeenCalled();
  expect(mockSettings.photoPromptAfterSaveShown).toBe(true);
});

it('waits for the Strava offer first when Strava is connected', async () => {
  mockStrava = { athleteId: 1 };
  await mount();
  await save('t1');
  await act(() => jest.advanceTimersByTime(AFTER_STRAVA_DELAY_MS - 1));
  expect(screen.queryByText('Add photos from this outing?')).toBeNull();
  await act(() => jest.advanceTimersByTime(2));
  expect(screen.getByText('Add photos from this outing?')).toBeOnTheScreen();
});

it('ignores a cleared save', async () => {
  await mount();
  await act(() => mockListener?.({ lastSavedTrackId: null }, { lastSavedTrackId: 't1' }));
  expect(mockSettings.set).not.toHaveBeenCalled();
});
