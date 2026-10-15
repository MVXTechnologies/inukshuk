import { BUSY_SHOW_AFTER_MS } from '@core/tasks/busyChip';
import { beginBusyTask, useBusyTasksStore } from '@state/busyTasksStore';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { darkTheme, lightTheme } from '@ui/theme';
import { PaperProvider } from 'react-native-paper';
import { BusyChip } from './BusyChip';

/** #721 — the map's one busy chip (mockup A1–A3). */
async function show(dark = false) {
  await render(
    <PaperProvider theme={dark ? darkTheme : lightTheme}>
      <BusyChip />
    </PaperProvider>,
  );
}

/**
 * Let `ms` pass, a frame at a time: each reveal timer re-arms after its
 * render commits, as on a device.
 */
async function advance(ms: number) {
  for (let left = ms; left > 0; left -= 16) {
    await act(async () => void jest.advanceTimersByTime(Math.min(16, left)));
  }
  await act(async () => void jest.advanceTimersByTime(0));
}

beforeEach(() => {
  jest.useFakeTimers();
  useBusyTasksStore.setState({ tasks: [] });
});
afterEach(() => jest.useRealTimers());

it('shows nothing while idle', async () => {
  await show();
  expect(screen.queryByTestId('busy-chip')).toBeNull();
});

it('never flashes: a task shows only after it has run 400 ms', async () => {
  await show();
  let slope!: ReturnType<typeof beginBusyTask>;
  await act(async () => {
    slope = beginBusyTask('slope');
  });
  await advance(BUSY_SHOW_AFTER_MS - 1);
  expect(screen.queryByTestId('busy-chip')).toBeNull();
  await advance(1);
  expect(screen.getByLabelText('Running: Slope')).toBeTruthy();
  // A quick one finishing under the threshold never shows at all.
  await act(async () => {
    const quick = beginBusyTask('contours');
    jest.advanceTimersByTime(200);
    quick.finish();
  });
  await advance(1000);
  expect(screen.getByLabelText('Running: Slope')).toBeTruthy();
  await act(async () => slope.finish());
  expect(screen.queryByTestId('busy-chip')).toBeNull();
});

it('names the longest-running task, "+N" counts the others (start order, not arrival)', async () => {
  await show();
  const now = Date.now();
  await act(async () => {
    beginBusyTask('pdf', { now: now - 100, label: 'p.2', subject: 'Charlevoix' });
    beginBusyTask('slope', { now: now - 300 });
    beginBusyTask('tiles', { now: now - 200, progress: { done: 12, total: 40 } });
  });
  await advance(BUSY_SHOW_AFTER_MS);
  const chip = screen.getByTestId('busy-chip');
  expect(chip.props.accessibilityLabel).toBe('Running: Slope, and 2 more');
  expect(screen.getByText('Slope')).toBeTruthy();
  expect(screen.getByText('+2')).toBeTruthy();
});

it('reads "Map tiles 12/40" and "PDF p.2" on the chip', async () => {
  await show();
  let tiles!: ReturnType<typeof beginBusyTask>;
  await act(async () => {
    tiles = beginBusyTask('tiles', { progress: { done: 12, total: 40 } });
  });
  await advance(BUSY_SHOW_AFTER_MS);
  expect(screen.getByText('Map tiles 12/40')).toBeTruthy();
  expect(screen.queryByTestId('busy-more')).toBeNull();
  await act(async () => {
    tiles.finish();
    beginBusyTask('pdf', { label: 'p.2', subject: 'Charlevoix' });
  });
  await advance(BUSY_SHOW_AFTER_MS);
  expect(screen.getByText('PDF p.2')).toBeTruthy();
});

it('a tap lists every task with a bar where progress counts; a tap outside closes', async () => {
  await show(true);
  const now = Date.now();
  await act(async () => {
    beginBusyTask('slope', { now: now - 400 });
    beginBusyTask('tiles', { now: now - 300, progress: { done: 12, total: 40 } });
    beginBusyTask('contours', { now: now - 200 });
    beginBusyTask('pdf', { now: now - 100, label: 'p.2', subject: 'Charlevoix' });
  });
  await advance(BUSY_SHOW_AFTER_MS);
  await fireEvent.press(screen.getByTestId('busy-chip'));
  expect(screen.getByTestId('busy-popover')).toBeTruthy();
  const rows = ['Slope', 'Map tiles, 12/40', 'Contours', 'PDF, Charlevoix · p.2'];
  for (const r of rows) expect(screen.getByLabelText(r)).toBeTruthy();
  expect(screen.getAllByTestId('busy-progress')).toHaveLength(1);
  expect(screen.getByTestId('busy-chip').props.accessibilityState).toMatchObject({
    expanded: true,
  });
  // The backdrop: a screen reader stays in the list (escape / Back closes it).
  await fireEvent.press(
    screen.getByLabelText('Close running tasks', { includeHiddenElements: true }),
  );
  expect(screen.queryByTestId('busy-popover')).toBeNull();
});

it('the list closes with the last task', async () => {
  await show();
  let t!: ReturnType<typeof beginBusyTask>;
  await act(async () => {
    t = beginBusyTask('slope', { now: Date.now() - 1000 });
  });
  await advance(0);
  await fireEvent.press(screen.getByTestId('busy-chip'));
  expect(screen.getByTestId('busy-popover')).toBeTruthy();
  await act(async () => t.finish());
  expect(screen.queryByTestId('busy-popover')).toBeNull();
  expect(screen.queryByTestId('busy-chip')).toBeNull();
});
