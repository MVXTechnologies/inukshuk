import type { TrackSummary } from '@core/models';
import type { TrackPhoto } from '@core/photos/model';
import { useSettingsStore } from '@state/settingsStore';
import { act, fireEvent, render } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ShareTrailSheet } from './ShareTrailSheet';

jest.mock('@data/storage', () => ({
  writeJson: jest.fn(),
  readJson: jest.fn(async () => null),
  resolveDocumentPath: (p: string) => (p.startsWith('file://') ? p : `file:///doc/${p}`),
  deleteFileAt: jest.fn(),
}));
jest.mock('@data/photos/zipExport', () => ({ writeTrailPhotoZip: jest.fn() }));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: jest.fn(async () => undefined),
}));

const sharing = jest.requireMock('expo-sharing') as {
  isAvailableAsync: jest.Mock;
  shareAsync: jest.Mock;
};
const zips = jest.requireMock('@data/photos/zipExport') as { writeTrailPhotoZip: jest.Mock };
const storage = jest.requireMock('@data/storage') as { deleteFileAt: jest.Mock };

const track = {
  id: 't1',
  name: 'Lac des Cygnes',
  fileUri: 'file:///doc/tracks/t1.gpx',
} as TrackSummary;
const photo = (id: string, extra: Partial<TrackPhoto> = {}) =>
  ({ id, distanceM: 0, file: `photos/t1/${id}.jpg`, ...extra }) as TrackPhoto;
const photos = [photo('a'), photo('b'), photo('h', { hidden: true }), photo('note:n')];

const onClose = jest.fn();
const onMessage = jest.fn();

beforeAll(async () => {
  await useSettingsStore.getState().hydrate();
});
beforeEach(() => jest.clearAllMocks());
afterEach(() => useSettingsStore.getState().reset());

function renderSheet(visible = true) {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <PaperProvider>
        <ShareTrailSheet
          visible={visible}
          track={track}
          photos={photos}
          onClose={onClose}
          onMessage={onMessage}
        />
      </PaperProvider>
    </SafeAreaProvider>,
  );
}

it('renders nothing while closed', async () => {
  const r = await renderSheet(false);
  expect(r.queryByTestId('share-trail-sheet')).toBeNull();
});

it('highlights the GPX by default, and the zip when the setting says so', async () => {
  let r = await renderSheet();
  expect(r.getByLabelText('GPX file only').props.accessibilityState.selected).toBe(true);
  expect(r.getByText('The GPX and 2 photos')).toBeTruthy();
  await r.unmount();
  useSettingsStore.getState().set('includePhotosWhenSharing', true);
  r = await renderSheet();
  expect(r.getByLabelText('Trail + photos (zip)').props.accessibilityState.selected).toBe(true);
});

it('shares the GPX alone', async () => {
  const r = await renderSheet();
  await act(async () => {
    fireEvent.press(r.getByLabelText('GPX file only'));
  });
  expect(sharing.shareAsync).toHaveBeenCalledWith('file:///doc/tracks/t1.gpx', {
    mimeType: 'application/gpx+xml',
    UTI: 'public.xml',
  });
  expect(zips.writeTrailPhotoZip).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalled();
});

it('zips the shown photos (no hidden, no note photos), shares, then deletes the zip', async () => {
  zips.writeTrailPhotoZip.mockResolvedValue({
    uri: 'file:///cache/exports/L.zip',
    name: 'L.zip',
    photos: 2,
    skipped: 0,
  });
  const r = await renderSheet();
  await act(async () => {
    fireEvent.press(r.getByLabelText('Trail + photos (zip)'));
  });
  const args = zips.writeTrailPhotoZip.mock.calls[0]![0] as { photos: TrackPhoto[] };
  expect(args.photos.map((p) => p.id)).toEqual(['a', 'b']);
  expect(sharing.shareAsync).toHaveBeenCalledWith(
    'file:///cache/exports/L.zip',
    expect.objectContaining({ mimeType: 'application/zip' }),
  );
  expect(storage.deleteFileAt).toHaveBeenCalledWith('file:///cache/exports/L.zip');
  expect(onMessage).not.toHaveBeenCalled();
});

it('says when photos were left out, and when the zip fails', async () => {
  zips.writeTrailPhotoZip.mockResolvedValueOnce({ uri: 'u', name: 'n', photos: 1, skipped: 1 });
  const r = await renderSheet();
  await act(async () => {
    fireEvent.press(r.getByLabelText('Trail + photos (zip)'));
  });
  expect(onMessage).toHaveBeenCalledWith('1 photo could not be checked and was left out');
  zips.writeTrailPhotoZip.mockRejectedValueOnce(new Error('disk'));
  await act(async () => {
    fireEvent.press(r.getByLabelText('Trail + photos (zip)'));
  });
  expect(onMessage).toHaveBeenCalledWith('Could not prepare the photos');
});

it('says when sharing is unavailable', async () => {
  sharing.isAvailableAsync.mockResolvedValueOnce(false);
  const r = await renderSheet();
  await act(async () => {
    fireEvent.press(r.getByLabelText('GPX file only'));
  });
  expect(onMessage).toHaveBeenCalledWith('Sharing is not available on this device');
  expect(sharing.shareAsync).not.toHaveBeenCalled();
});
