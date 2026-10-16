import {
  finishBusyTask,
  startBusyTask,
  summarizeBusy,
  updateBusyTask,
  type BusyProgress,
  type BusySummary,
  type BusyTaskPatch,
  type BusyTaskKind,
  type BusyTasks,
} from '@core/tasks/busyTasks';
import { useMemo } from 'react';
import { create } from 'zustand';

/**
 * Live registry of background work (#721/#722): slope/contour computes, tile
 * downloads, PDF page renders. Producers call {@link beginBusyTask} and
 * finish the handle (in a `finally`); the map's busy chip (#721) reads
 * {@link useBusyTasks}.
 */
interface BusyTasksState {
  tasks: BusyTasks;
}

export const useBusyTasksStore = create<BusyTasksState>(() => ({ tasks: [] }));

export interface BusyTaskHandle {
  readonly id: string;
  update: (patch: BusyTaskPatch) => void;
  /** Idempotent. */
  finish: () => void;
}

let seq = 0;

export function beginBusyTask(
  kind: BusyTaskKind,
  opts: { label?: string; subject?: string; progress?: BusyProgress; now?: number } = {},
): BusyTaskHandle {
  const id = `${kind}-${++seq}`;
  const { now = Date.now(), ...rest } = opts;
  useBusyTasksStore.setState((s) => ({
    tasks: startBusyTask(s.tasks, { id, kind, startedAt: now, ...rest }),
  }));
  return {
    id,
    update: (patch) =>
      useBusyTasksStore.setState((s) => ({ tasks: updateBusyTask(s.tasks, id, patch) })),
    finish: () => useBusyTasksStore.setState((s) => ({ tasks: finishBusyTask(s.tasks, id) })),
  };
}

/** The running tasks and their summary (longest-running, "+N", kinds). */
export function useBusyTasks(): BusySummary & { tasks: BusyTasks } {
  const tasks = useBusyTasksStore((s) => s.tasks);
  return useMemo(() => ({ ...summarizeBusy(tasks), tasks }), [tasks]);
}
