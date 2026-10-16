import type { BusyTask, BusyTasks } from './busyTasks';

/**
 * How the map's busy chip (#721, mockup A1–A3) reads the busy-task registry:
 * which tasks show, which one names the chip, and the words for each.
 *
 * - A task shows only once it has run {@link BUSY_SHOW_AFTER_MS}: a slope
 *   recompute from cached tiles or a quick PDF page never flashes a chip.
 * - The longest-running visible task (earliest start) names the chip; the
 *   others are its "+N".
 */

/** A task stays off the chip until it has run this long (no flashing). */
export const BUSY_SHOW_AFTER_MS = 400;

/** The tasks the chip shows at `now`, oldest first (ties keep start order). */
export function visibleBusyTasks(tasks: BusyTasks, now: number): BusyTask[] {
  return tasks
    .filter((t) => now - t.startedAt >= BUSY_SHOW_AFTER_MS)
    .sort((a, b) => a.startedAt - b.startedAt);
}

/** When the next hidden task crosses the threshold, or null if none is waiting. */
export function nextBusyRevealAt(tasks: BusyTasks, now: number): number | null {
  let next: number | null = null;
  for (const t of tasks) {
    const at = t.startedAt + BUSY_SHOW_AFTER_MS;
    if (at > now && (next === null || at < next)) next = at;
  }
  return next;
}

/** "12/40", or null when the task has no progress to count. */
export function busyProgressText(task: BusyTask): string | null {
  const p = task.progress;
  if (p === undefined || !(p.total > 0)) return null;
  return `${Math.max(0, Math.min(p.total, p.done))}/${p.total}`;
}

/** Progress as 0..1 for the popover's bar, or null when not countable. */
export function busyFraction(task: BusyTask): number | null {
  const p = task.progress;
  if (p === undefined || !(p.total > 0)) return null;
  return Math.max(0, Math.min(1, p.done / p.total));
}

const TITLE: Record<BusyTask['kind'], string> = {
  slope: 'Slope',
  contours: 'Contours',
  tiles: 'Map tiles',
  pdf: 'PDF',
};

/** The chip's one-line name for a task: "Slope", "Map tiles 12/40", "PDF p.2". */
export function busyChipLabel(task: BusyTask): string {
  const extra = task.kind === 'tiles' ? busyProgressText(task) : (task.label ?? null);
  return extra === null || extra === '' ? TITLE[task.kind] : `${TITLE[task.kind]} ${extra}`;
}

/** A popover row: bold title, quiet detail ("Map tiles" · "12/40", "PDF" · "Charlevoix · p.2"). */
export function busyRowText(task: BusyTask): { title: string; detail: string } {
  const parts =
    task.kind === 'tiles'
      ? [task.subject, busyProgressText(task)]
      : [task.subject, task.label, task.kind === 'pdf' ? null : busyProgressText(task)];
  return {
    title: TITLE[task.kind],
    detail: parts.filter((p): p is string => typeof p === 'string' && p !== '').join(' · '),
  };
}

/** The chip's accessibility label: "Running: Slope, and 2 more". */
export function busyChipA11yLabel(visible: readonly BusyTask[]): string {
  const first = visible[0];
  if (first === undefined) return '';
  const more = visible.length - 1;
  return `Running: ${busyChipLabel(first)}${more > 0 ? `, and ${more} more` : ''}`;
}

/** A popover row read as one sentence: "Map tiles, 12/40". */
export function busyRowA11yLabel(task: BusyTask): string {
  const { title, detail } = busyRowText(task);
  return detail === '' ? title : `${title}, ${detail}`;
}
