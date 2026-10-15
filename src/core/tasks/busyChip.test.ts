import {
  BUSY_SHOW_AFTER_MS,
  busyChipA11yLabel,
  busyChipLabel,
  busyFraction,
  busyProgressText,
  busyRowA11yLabel,
  busyRowText,
  nextBusyRevealAt,
  visibleBusyTasks,
} from './busyChip';
import type { BusyTask } from './busyTasks';

const t = (over: Partial<BusyTask> & Pick<BusyTask, 'id' | 'kind'>): BusyTask => ({
  startedAt: 0,
  ...over,
});

describe('busy chip', () => {
  it('waits 400 ms before showing a task', () => {
    expect(BUSY_SHOW_AFTER_MS).toBe(400);
    const tasks = [t({ id: 'a', kind: 'slope', startedAt: 1000 })];
    expect(visibleBusyTasks(tasks, 1399)).toEqual([]);
    expect(visibleBusyTasks(tasks, 1400).map((x) => x.id)).toEqual(['a']);
  });

  it('orders visible tasks by start time, oldest first', () => {
    const tasks = [
      t({ id: 'pdf', kind: 'pdf', startedAt: 300 }),
      t({ id: 'slope', kind: 'slope', startedAt: 100 }),
      t({ id: 'contours', kind: 'contours', startedAt: 200 }),
      t({ id: 'young', kind: 'tiles', startedAt: 900 }),
    ];
    expect(visibleBusyTasks(tasks, 1000).map((x) => x.id)).toEqual(['slope', 'contours', 'pdf']);
  });

  it('knows when the next hidden task is due', () => {
    const tasks = [
      t({ id: 'a', kind: 'slope', startedAt: 0 }),
      t({ id: 'b', kind: 'pdf', startedAt: 700 }),
      t({ id: 'c', kind: 'pdf', startedAt: 500 }),
    ];
    expect(nextBusyRevealAt(tasks, 600)).toBe(900);
    expect(nextBusyRevealAt(tasks, 1200)).toBeNull();
    expect(nextBusyRevealAt([], 0)).toBeNull();
  });

  it('names each kind as in the mockup', () => {
    expect(busyChipLabel(t({ id: 's', kind: 'slope' }))).toBe('Slope');
    expect(busyChipLabel(t({ id: 'c', kind: 'contours' }))).toBe('Contours');
    expect(busyChipLabel(t({ id: 'm', kind: 'tiles', progress: { done: 12, total: 40 } }))).toBe(
      'Map tiles 12/40',
    );
    expect(busyChipLabel(t({ id: 'm', kind: 'tiles' }))).toBe('Map tiles');
    expect(
      busyChipLabel(
        t({ id: 'o', kind: 'tiles', progress: { done: 44.6, total: 100, percent: true } }),
      ),
    ).toBe('Map tiles 45%');
    expect(busyChipLabel(t({ id: 'p', kind: 'pdf', label: 'p.2', subject: 'Charlevoix' }))).toBe(
      'PDF p.2',
    );
  });

  it('popover rows: title + detail, a bar only where progress counts', () => {
    const pdf = t({ id: 'p', kind: 'pdf', label: 'p.2', subject: 'Charlevoix' });
    const tiles = t({ id: 'm', kind: 'tiles', progress: { done: 12, total: 40 } });
    const slope = t({ id: 's', kind: 'slope' });
    expect(busyRowText(pdf)).toEqual({ title: 'PDF', detail: 'Charlevoix · p.2' });
    expect(busyRowText(tiles)).toEqual({ title: 'Map tiles', detail: '12/40' });
    expect(busyRowText(slope)).toEqual({ title: 'Slope', detail: '' });
    expect(busyFraction(tiles)).toBeCloseTo(0.3);
    expect(busyFraction(slope)).toBeNull();
    expect(busyFraction(t({ id: 'z', kind: 'tiles', progress: { done: 0, total: 0 } }))).toBeNull();
    expect(busyProgressText(t({ id: 'x', kind: 'tiles', progress: { done: 50, total: 40 } }))).toBe(
      '40/40',
    );
    expect(busyRowA11yLabel(pdf)).toBe('PDF, Charlevoix · p.2');
    expect(busyRowA11yLabel(slope)).toBe('Slope');
  });

  it('reads the chip as "Running: Slope, and 2 more"', () => {
    const v = [
      t({ id: 's', kind: 'slope' }),
      t({ id: 'c', kind: 'contours' }),
      t({ id: 'p', kind: 'pdf' }),
    ];
    expect(busyChipA11yLabel(v)).toBe('Running: Slope, and 2 more');
    expect(busyChipA11yLabel(v.slice(0, 1))).toBe('Running: Slope');
    expect(busyChipA11yLabel([])).toBe('');
  });
});
