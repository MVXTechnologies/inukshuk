import type { TeamTask } from '@core/team/tasks';
import { teamService, useTeamStore } from '@state/teamStore';
import { useCallback } from 'react';

/** Tick a task (or open it again) as me; the fold decides whether it counts. */
export function useToggleTask(): (task: TeamTask) => void {
  return useCallback((task: TeamTask) => {
    const session = teamService()?.active;
    if (!session) return;
    session.setTaskDone(task.owner, task.id, !task.done);
    useTeamStore.getState().refresh();
  }, []);
}
