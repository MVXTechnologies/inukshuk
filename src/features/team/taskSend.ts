/**
 * Sending a team comment that may carry `+task @name …` (#589): the comment
 * goes first (it is the task's source), then the task, anchored where the
 * comment is (a photo, a pin, a trail). A malformed command sends nothing and
 * says what is missing, so a typo never turns into a silent plain comment.
 */
import type { TaskAnchor } from '@core/team/tasks';
import { parseTaskCommand } from '@core/teamui/tasks';
import type { MemberRow } from '@core/teamui/view';
import type { ActionError, TeamSession } from '@data/team/teamSession';
import { useTeamStore } from '@state/teamStore';

import { actionMessage } from './messages';

export const TASK_COMMAND_ERRORS = {
  'no-assignee': 'Say who it is for: +task @name what to do',
  guest: 'Guests can comment but can’t be given tasks.',
  empty: 'Say what to do after the name: +task @name what to do',
  'too-long': 'A task is at most 500 characters.',
} as const;

export function sendTeamComment({
  session,
  text,
  members,
  anchor,
  write,
}: {
  session: TeamSession;
  text: string;
  members: readonly MemberRow[];
  /** Where a task made from it is anchored (given the comment's id, for a new pin). */
  anchor: TaskAnchor | null | ((id: string) => TaskAnchor | null);
  /** Write the comment with this id; an error, or null when written. */
  write: (id: string) => ActionError | null;
}): string | null {
  const cmd = parseTaskCommand(text, members);
  if (cmd !== null && !cmd.ok) return TASK_COMMAND_ERRORS[cmd.reason];
  if (cmd !== null && session.myRole === 'guest') return 'Guests can comment but can’t give tasks.';
  const id = session.newId();
  const err = write(id);
  if (err) return actionMessage(err);
  if (cmd !== null) {
    const taskErr = session.createTask({
      title: cmd.title,
      assignee: cmd.assignee,
      anchor: typeof anchor === 'function' ? anchor(id) : anchor,
      source: { owner: session.me, id },
    });
    if (taskErr) return `Comment sent, but not the task: ${actionMessage(taskErr)}`;
  }
  useTeamStore.getState().refresh();
  return null;
}
