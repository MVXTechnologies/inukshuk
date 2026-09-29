/** The Library's import card in each job state (#432/#435, boards ImportProgress / ImportDone). */
import { newImportJob, type ImportJob } from '@core/import/job';
import type { TrackSummary } from '@core/models';
import { useImportStore } from '@state/importStore';
import { useLibraryStore } from '@state/libraryStore';
import { useMapStore } from '@state/mapStore';
import { useSettingsStore } from '@state/settingsStore';
import { act, fireEvent, render, type RenderResult } from '@testing-library/react-native';
import { PaperProvider } from 'react-native-paper';

import { ImportJobCard } from './ImportJobCard';

const mockNavigate = jest.fn();
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ navigate: mockNavigate, push: mockPush }),
}));
const mockResume = jest.fn(async () => undefined);
const mockStop = jest.fn();
const mockDismiss = jest.fn();
jest.mock('./importController', () => ({
  resumeSourceImport: () => mockResume(),
  stopSourceImport: () => mockStop(),
  dismissImportJob: () => mockDismiss(),
}));
jest.mock('@data/storage', () => ({ writeJson: jest.fn(), writeIndex: jest.fn() }));

const job = (over: Partial<ImportJob> = {}): ImportJob => ({
  ...newImportJob({ source: 'strava', range: { kind: 'everything' }, since: 0, now: 1 }),
  listing: false,
  ...over,
});

async function show(j: ImportJob | null): Promise<RenderResult> {
  useImportStore.setState({ job: j });
  return render(
    <PaperProvider>
      <ImportJobCard />
    </PaperProvider>,
  );
}

async function press(node: Parameters<typeof fireEvent.press>[0]) {
  await act(async () => {
    fireEvent.press(node);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  useSettingsStore.setState({ units: 'metric', showHeatmap: false });
});

it('renders nothing without a job', async () => {
  const view = await show(null);
  expect(view.queryByText(/Import/)).toBeNull();
  expect(view.queryByText(/imported/)).toBeNull();
});

it('shows progress, the skipped line and Stop while running', async () => {
  const view = await show(job({ total: 41, done: 24, skippedDuplicates: 2 }));
  expect(view.getByText('Importing from Strava')).toBeOnTheScreen();
  expect(view.getByText('24 / 41')).toBeOnTheScreen();
  expect(view.getByRole('progressbar')).toHaveProp('accessibilityValue', {
    min: 0,
    max: 100,
    now: 59,
  });
  expect(view.getByText('2 already in your Library · skipped')).toBeOnTheScreen();
  expect(view.queryByLabelText('Resume import')).toBeNull();
  await press(view.getByLabelText('Stop import'));
  expect(mockStop).toHaveBeenCalled();
});

it('says it is getting the list while listing', async () => {
  const view = await show(job({ listing: true }));
  expect(view.getByText('Getting your Strava activities…')).toBeOnTheScreen();
  expect(view.queryByRole('progressbar')).toBeNull();
});

it('shows Strava’s rate-limit wait with the resume time', async () => {
  const resumeAt = new Date(2026, 8, 28, 13, 15).getTime();
  const view = await show(job({ total: 41, done: 24, pause: { kind: 'rate-limit', resumeAt } }));
  expect(view.getByText(/Strava’s rate limit reached\. Resuming at/)).toBeOnTheScreen();
  expect(view.getByText(/:15/)).toBeOnTheScreen();
  expect(view.getByText(/you can keep using the app/)).toBeOnTheScreen();
});

it('offers Resume after the app closed mid-import', async () => {
  const view = await show(
    job({ status: 'paused', pausedReason: 'interrupted', total: 10, done: 3, noGps: 1 }),
  );
  expect(view.getByText('Import paused')).toBeOnTheScreen();
  expect(view.getByText('Inukshuk closed before it finished.')).toBeOnTheScreen();
  expect(view.getByText('1 without GPS · skipped')).toBeOnTheScreen();
  await press(view.getByLabelText('Resume import'));
  expect(mockResume).toHaveBeenCalled();
});

it('summarizes a finished import and shows it on the heatmap', async () => {
  const bbox = { minLat: 46.8, maxLat: 46.9, minLng: -71.3, maxLng: -71.2 };
  const imported: TrackSummary = {
    id: 't1',
    name: 'Crête',
    startedAt: 1,
    fileUri: 'file:///t1.gpx',
    stats: {
      distanceM: 212_000,
      ascentM: 6480,
      descentM: 0,
      durationS: 0,
      movingTimeS: 0,
      avgSpeedMps: 0,
      maxSpeedMps: 0,
      pointCount: 2,
      bbox,
    },
  };
  useLibraryStore.setState({ tracks: [imported] });
  const view = await show(
    job({
      status: 'done',
      total: 42,
      done: 42,
      imported: 39,
      skippedDuplicates: 2,
      noGps: 3,
      distanceM: 212_000,
      ascentM: 6480,
      importedTrackIds: ['t1'],
    }),
  );
  expect(view.getByText('39 activities imported')).toBeOnTheScreen();
  expect(view.getByText('from Strava · 212 km · +6480 m')).toBeOnTheScreen();
  expect(view.getByText('new trails')).toBeOnTheScreen();
  expect(view.getByText('already here')).toBeOnTheScreen();
  expect(view.getByText('indoor, no GPS')).toBeOnTheScreen();

  await press(view.getByText('Show on heatmap'));
  expect(useSettingsStore.getState().showHeatmap).toBe(true);
  expect(useMapStore.getState().focusBounds).toEqual(bbox);
  expect(mockDismiss).toHaveBeenCalled();
  expect(mockNavigate).toHaveBeenCalledWith('/');

  await press(view.getByText('Dismiss'));
  expect(mockDismiss).toHaveBeenCalledTimes(2);
});

it('has no heatmap button when nothing was imported', async () => {
  const view = await show(job({ status: 'done', source: 'apple-health', noGps: 2 }));
  expect(view.getByText('0 activities imported')).toBeOnTheScreen();
  expect(view.getByText('from Apple Health')).toBeOnTheScreen();
  expect(view.getByText('no GPS')).toBeOnTheScreen();
  expect(view.queryByText('Show on heatmap')).toBeNull();
});

it('lets a stopped import be resumed', async () => {
  const view = await show(job({ status: 'stopped', total: 41, done: 24, imported: 20, failed: 1 }));
  expect(view.getByText('Import stopped · 24 of 41')).toBeOnTheScreen();
  expect(view.getByText(/1 couldn’t load/)).toBeOnTheScreen();
  await press(view.getByText('Resume'));
  expect(mockResume).toHaveBeenCalled();
});

it('sends an auth failure to Settings, and retries other failures', async () => {
  const view = await show(
    job({
      status: 'error',
      errorKind: 'auth',
      message: 'Strava refused access — reconnect in Settings',
      imported: 3,
    }),
  );
  expect(
    view.getByText('Strava refused access — reconnect in Settings 3 trails came in first.'),
  ).toBeOnTheScreen();
  await press(view.getByText('Open Settings'));
  expect(mockPush).toHaveBeenCalledWith('/settings');
});

it('retries a failure that is not about access', async () => {
  const other = await show(job({ status: 'error', errorKind: 'other', message: null }));
  await press(other.getAllByText('Try again')[0]!);
  expect(mockResume).toHaveBeenCalled();
});

it('waits out the daily limit and resumes by itself', async () => {
  jest.useFakeTimers();
  try {
    const resumeAt = Date.now() + 60_000;
    const view = await show(
      job({ status: 'paused', pausedReason: 'daily-limit', resumeAt, total: 900, done: 480 }),
    );
    expect(
      view.getByText(/Strava’s daily limit reached\. The import picks up again after/),
    ).toBeOnTheScreen();
    expect(view.queryByLabelText('Resume import')).toBeNull();
    await act(async () => {
      jest.advanceTimersByTime(59_000);
    });
    expect(mockResume).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(3_000);
    });
    expect(mockResume).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});
