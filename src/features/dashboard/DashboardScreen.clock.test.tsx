import { computeTrackStats } from '@core/geo/track';
import { useLibraryStore } from '@state/libraryStore';
import { act, render } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ActivityGraph } from './ActivityGraph';
import { DashboardScreen } from './DashboardScreen';
import { DayActivitiesDialog } from './DayActivitiesDialog';
import { MonthCalendar } from './MonthCalendar';

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@data/storage', () => ({}));
jest.mock('./ActivityGraph', () => ({ ActivityGraph: jest.fn(() => null) }));
jest.mock('./MonthCalendar', () => ({ MonthCalendar: jest.fn(() => null) }));
jest.mock('./LifetimeSummary', () => ({ LifetimeSummary: () => null }));
jest.mock('./DayActivitiesDialog', () => ({ DayActivitiesDialog: jest.fn(() => null) }));

let appStateChanged: ((state: AppStateStatus) => void) | undefined;
const removeListener = jest.fn();
const calendar = () => jest.mocked(MonthCalendar).mock.calls.at(-1)![0];
const graph = () => jest.mocked(ActivityGraph).mock.calls.at(-1)![0];
const lastDay = () => graph().buckets.at(-1)!.startMs;

async function show() {
  useLibraryStore.setState({
    tracks: [
      {
        id: 'trail',
        name: 'Trail',
        fileUri: 'trail.gpx',
        startedAt: new Date(2025, 11, 1).getTime(),
        stats: computeTrackStats([]),
      },
    ],
    customCategories: [],
  });
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <PaperProvider>
        <DashboardScreen />
      </PaperProvider>
    </SafeAreaProvider>,
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(2026, 0, 31, 23, 59, 59));
  appStateChanged = undefined;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((event, listener) => {
    if (event === 'change') appStateChanged = listener;
    return { remove: removeListener };
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it('advances graph boundaries and the default calendar month at local midnight, and rearms', async () => {
  const view = await show();
  expect(lastDay()).toBe(new Date(2026, 0, 31).getTime());
  await act(() => jest.advanceTimersByTime(1000));
  expect(lastDay()).toBe(new Date(2026, 1, 1).getTime());
  expect(calendar()).toMatchObject({
    year: 2026,
    month: 1,
    canNext: false,
    todayMs: new Date(2026, 1, 1).getTime(),
  });
  await act(() => jest.advanceTimersByTime(86_400_000));
  expect(lastDay()).toBe(new Date(2026, 1, 2).getTime());
  await view.unmount();
});

it('refreshes after sleeping across month boundaries without advancing a browsed month', async () => {
  const view = await show();
  await act(() => calendar().onPrev());
  expect(calendar()).toMatchObject({ year: 2025, month: 11 });
  await act(() => appStateChanged?.('background'));
  jest.setSystemTime(new Date(2026, 2, 4, 9));
  await act(() => appStateChanged?.('active'));
  expect(lastDay()).toBe(new Date(2026, 2, 4).getTime());
  expect(calendar()).toMatchObject({ year: 2025, month: 11, canNext: true });
  await view.unmount();
});

it('refreshes the default calendar on foreground and removes the pending midnight timer on unmount', async () => {
  const timerSpy = jest.spyOn(global, 'setTimeout');
  const clearSpy = jest.spyOn(global, 'clearTimeout');
  const view = await show();
  await act(() => appStateChanged?.('background'));
  jest.setSystemTime(new Date(2026, 1, 3, 12));
  await act(() => appStateChanged?.('active'));
  expect(calendar()).toMatchObject({ year: 2026, month: 1 });
  expect(lastDay()).toBe(new Date(2026, 1, 3).getTime());
  const timerIndex = timerSpy.mock.calls.findIndex((call) => call[1] === 12 * 60 * 60 * 1000);
  expect(timerIndex).toBeGreaterThanOrEqual(0);
  const pendingTimer = timerSpy.mock.results[timerIndex]!.value;
  await view.unmount();
  expect(clearSpy).toHaveBeenCalledWith(pendingTimer);
  expect(removeListener).toHaveBeenCalledTimes(1);
});

it('keeps the explicitly selected month while its next-month boundary advances at midnight', async () => {
  const view = await show();
  await act(() => calendar().onPrev());
  await act(() => calendar().onNext());
  expect(calendar()).toMatchObject({ month: 0, canNext: false });
  await act(() => jest.advanceTimersByTime(1000));
  expect(calendar()).toMatchObject({ month: 0, canNext: true });
  expect(lastDay()).toBe(new Date(2026, 1, 1).getTime());
  await view.unmount();
});

it.each([new Date(2026, 2, 8), new Date(2026, 10, 1)])(
  'schedules using the next local midnight across daylight-saving transitions (%s)',
  async (start) => {
    jest.setSystemTime(start);
    const view = await show();
    const nextDay = new Date(start);
    nextDay.setDate(nextDay.getDate() + 1);
    const delay = nextDay.getTime() - start.getTime();
    await act(() => jest.advanceTimersByTime(delay - 1));
    expect(lastDay()).toBe(start.getTime());
    await act(() => jest.advanceTimersByTime(1));
    expect(lastDay()).toBe(nextDay.getTime());
    await view.unmount();
  },
);

it('keeps an open activity dialog attached to its picked date when the calendar advances', async () => {
  const view = await show();
  await act(() =>
    useLibraryStore.setState({
      tracks: ['a', 'b'].map((id) => ({
        id,
        name: id,
        fileUri: id,
        startedAt: new Date(2026, 0, 31, 12).getTime(),
        stats: computeTrackStats([]),
      })),
    }),
  );
  await act(() => calendar().onDayPress(calendar().entries[0]!));
  const dialog = () => jest.mocked(DayActivitiesDialog).mock.calls.at(-1)![0];
  const pickedTitle = dialog().title;
  expect(dialog().tracks).toHaveLength(2);
  await act(() => jest.advanceTimersByTime(1000));
  expect(calendar().month).toBe(1);
  expect(dialog().title).toBe(pickedTitle);
  await view.unmount();
});
