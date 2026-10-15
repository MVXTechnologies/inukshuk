/**
 * Registry of background work the map is doing (#721/#722): slope and
 * contour computes, tile downloads, PDF page renders. Pure state transitions
 * and the summary a status chip needs ("Slope… +2"); the store lives in
 * `@state/busyTasksStore`; the chip's own rules (what shows, how it reads)
 * are in `./busyChip`.
 */

export type BusyTaskKind = 'slope' | 'contours' | 'tiles' | 'pdf';

export interface BusyProgress {
  done: number;
  total: number;
  /** `done` is a percentage of 100 (a download that reports no count). */
  percent?: boolean;
}

export interface BusyTask {
  id: string;
  kind: BusyTaskKind;
  /** Epoch ms the task started (the chip names the longest-running one). */
  startedAt: number;
  /** Optional detail, e.g. "p.3" for a PDF render. */
  label?: string;
  /** What the task works on, e.g. the PDF map's or the offline region's name. */
  subject?: string;
  progress?: BusyProgress;
}

/** What a running task may change about itself. */
export type BusyTaskPatch = Pick<BusyTask, 'label' | 'subject' | 'progress'>;

/** Tasks in start order (oldest first). */
export type BusyTasks = readonly BusyTask[];

export function startBusyTask(tasks: BusyTasks, task: BusyTask): BusyTasks {
  // Re-starting an id replaces it (a retried job keeps one entry).
  return [...tasks.filter((t) => t.id !== task.id), task];
}

export function updateBusyTask(tasks: BusyTasks, id: string, patch: BusyTaskPatch): BusyTasks {
  if (!tasks.some((t) => t.id === id)) return tasks; // already finished: no resurrection
  return tasks.map((t) => (t.id === id ? { ...t, ...patch } : t));
}

export function finishBusyTask(tasks: BusyTasks, id: string): BusyTasks {
  return tasks.some((t) => t.id === id) ? tasks.filter((t) => t.id !== id) : tasks;
}

export interface BusySummary {
  count: number;
  /** The longest-running task (earliest start), or null when idle. */
  longest: BusyTask | null;
  /** How many others are running besides `longest` (the chip's "+N"). */
  others: number;
  kinds: BusyTaskKind[];
}

export function summarizeBusy(tasks: BusyTasks): BusySummary {
  let longest: BusyTask | null = null;
  const kinds: BusyTaskKind[] = [];
  for (const t of tasks) {
    if (longest === null || t.startedAt < longest.startedAt) longest = t;
    if (!kinds.includes(t.kind)) kinds.push(t.kind);
  }
  return { count: tasks.length, longest, others: Math.max(0, tasks.length - 1), kinds };
}
