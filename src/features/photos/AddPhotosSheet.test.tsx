import type { TrackSummary } from '@core/models';
import type { ImportPlan, PlannedPhoto } from '@core/photos/placement';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AddPhotosSheet } from './AddPhotosSheet';

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(),
  UIImagePickerPreferredAssetRepresentationMode: { Compatible: 'compatible' },
}));
jest.mock('@lib/errorReporting', () => ({ reportError: jest.fn() }));
jest.mock('@data/storage', () => ({
  newId: jest.fn(() => 'id'),
  isCacheUri: (u: string) => u.includes('/cache/'),
  deleteFileAt: jest.fn(),
}));
jest.mock('./photoResizer', () => ({ photoResizer: { resize: jest.fn() } }));
jest.mock('@data/photos/importPhotos', () => ({
  preparePhotoImport: jest.fn(),
  commitPhotoImport: jest.fn(),
  defaultSelection: (p: { plan: ImportPlan }) =>
    new Set([...p.plan.byTime, ...p.plan.byGps].map((x) => x.candidate.key)),
}));

const picker = jest.requireMock('expo-image-picker') as { launchImageLibraryAsync: jest.Mock };
const importer = jest.requireMock('@data/photos/importPhotos') as {
  preparePhotoImport: jest.Mock;
  commitPhotoImport: jest.Mock;
};
const storage = jest.requireMock('@data/storage') as { deleteFileAt: jest.Mock };

const pos = { distanceM: 1950, lngLat: [-71, 47] as [number, number] };
const timed = (key: string): PlannedPhoto => ({
  candidate: { key, takenAt: 10 },
  result: { kind: 'time', position: pos, takenAt: 10 },
  clockOffsetMs: 0,
});
const plan: ImportPlan = {
  clock: { status: 'ok', offsetMs: 0, samples: 3 },
  cameraClocks: new Map(),
  byTime: [timed('pick-0'), timed('pick-1')],
  byGps: [
    {
      candidate: { key: 'pick-2' },
      result: { kind: 'gps', position: pos, offTrackM: 9 },
      clockOffsetMs: 0,
    },
  ],
  outside: [
    {
      candidate: { key: 'pick-3', takenAt: 5 },
      result: { kind: 'outside', reason: 'time' },
      clockOffsetMs: 0,
    },
  ],
};
const items = new Map(
  [0, 1, 2, 3].map((i) => [`pick-${i}`, { picked: { uri: `file:///cache/p${i}.jpg` } }]),
);

const track = { id: 't1', name: 'Lac des Cygnes' } as TrackSummary;

async function open(onDone = jest.fn(), onClose = jest.fn()) {
  await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <PaperProvider>
        <AddPhotosSheet visible track={track} points={[]} onClose={onClose} onDone={onDone} />
      </PaperProvider>
    </SafeAreaProvider>,
  );
  return { onDone, onClose };
}

beforeEach(() => {
  jest.clearAllMocks();
  picker.launchImageLibraryAsync.mockResolvedValue({
    canceled: false,
    assets: [0, 1, 2, 3].map((i) => ({ uri: `file:///cache/p${i}.jpg`, width: 10, height: 10 })),
  });
  importer.preparePhotoImport.mockResolvedValue({
    trackId: 't1',
    index: { startMs: 1, endMs: 2 },
    plan,
    items,
    duplicates: 1,
  });
});

it('opens the picker, then shows the three groups with the outsiders left out', async () => {
  await open();
  expect(picker.launchImageLibraryAsync).toHaveBeenCalledWith(
    expect.objectContaining({ allowsMultipleSelection: true, exif: true, selectionLimit: 200 }),
  );
  expect(await screen.findByText('4 photos selected')).toBeOnTheScreen();
  expect(screen.getByText(/1 already on this trail/)).toBeOnTheScreen();
  expect(screen.getByLabelText('On the trail, by time')).toHaveProp('accessibilityState', {
    checked: true,
    disabled: false,
  });
  expect(screen.getByLabelText('Not from this outing')).toHaveProp('accessibilityState', {
    checked: false,
    disabled: false,
  });
  expect(screen.getByText('Camera clock matches your GPS')).toBeOnTheScreen();
  expect(screen.getByText(/Nothing is uploaded/)).toBeOnTheScreen();
  expect(screen.getByLabelText('Add 3 photos')).toBeOnTheScreen();
});

it('adds the ticked photos and reports the result', async () => {
  importer.commitPhotoImport.mockResolvedValue({ added: [1, 2, 3, 4], failed: [] });
  const { onDone } = await open();
  await fireEvent.press(await screen.findByLabelText('Not from this outing'));
  await fireEvent.press(screen.getByLabelText('Add 4 photos'));
  await waitFor(() => expect(onDone).toHaveBeenCalledWith('Added 4 photos'));
  const args = importer.commitPhotoImport.mock.calls[0]![0] as { selected: Set<string> };
  expect([...args.selected].sort()).toEqual(['pick-0', 'pick-1', 'pick-2', 'pick-3']);
});

it('keeps the Add button in place while adding, so a second tap cannot cancel', async () => {
  let finish: (v: unknown) => void = () => {};
  importer.commitPhotoImport.mockReturnValue(new Promise((resolve) => (finish = resolve)));
  await open();
  await fireEvent.press(await screen.findByLabelText('Add 3 photos'));
  const adding = await screen.findByLabelText('Adding…');
  expect(adding).toBeDisabled();
  await fireEvent.press(adding);
  const args = importer.commitPhotoImport.mock.calls[0]![0] as { isCancelled: () => boolean };
  expect(args.isCancelled()).toBe(false);
  finish({ added: [1, 2, 3], failed: [] });
});

it('re-plans with the Adjust stepper', async () => {
  await open();
  await fireEvent.press(await screen.findByLabelText('Adjust camera clock'));
  await fireEvent.press(screen.getByLabelText('One hour later'));
  await waitFor(() =>
    expect(importer.preparePhotoImport).toHaveBeenLastCalledWith(
      expect.objectContaining({ manualClockOffsetMs: 3_600_000 }),
    ),
  );
});

it('closes when the picker is cancelled', async () => {
  picker.launchImageLibraryAsync.mockResolvedValueOnce({ canceled: true, assets: null });
  const { onClose } = await open();
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(importer.preparePhotoImport).not.toHaveBeenCalled();
});

it('blocks a trail whose photos were saved by a newer version', async () => {
  importer.preparePhotoImport.mockRejectedValueOnce(
    Object.assign(new Error('newer'), { status: 'future' }),
  );
  const { onDone } = await open();
  await waitFor(() =>
    expect(onDone).toHaveBeenCalledWith(expect.stringMatching(/newer version of Inukshuk/)),
  );
});

it('deletes the picker’s cache copies when it closes', async () => {
  importer.commitPhotoImport.mockResolvedValue({ added: [1], failed: [] });
  const view = await open();
  await screen.findByText('4 photos selected');
  await screen.unmount();
  expect(storage.deleteFileAt).toHaveBeenCalledTimes(4);
  expect(view.onClose).not.toHaveBeenCalled();
});
