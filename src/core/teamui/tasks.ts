/**
 * Team tasks in the UI (#589): the `+task @name …` command in comments, and
 * the task list's filters and groups. Pure. The task entity and its rules
 * are `@core/team/tasks`.
 */
import { MAX_TASK_TITLE, type TeamTask } from '@core/team/tasks';

import type { MemberRow } from './view';

export type TaskCommand =
  | { ok: true; assignee: string; title: string }
  | { ok: false; reason: 'no-assignee' | 'guest' | 'empty' | 'too-long' };

const COMMAND = /(^|\s)\+task\b/iu;

/** Whether the text holds a `+task` command (for a hint while typing). */
export function hasTaskCommand(text: string): boolean {
  return COMMAND.test(text);
}

/**
 * `+task @Name what to do`: the member (longest active name wins; me too) and
 * the title. Null when there is no `+task`. A guest can't be assigned (guests
 * only comment, so they could never mark it done).
 */
export function parseTaskCommand(text: string, members: readonly MemberRow[]): TaskCommand | null {
  const m = COMMAND.exec(text);
  if (!m) return null;
  const after = text.slice(m.index + m[0].length).trimStart();
  if (!after.startsWith('@')) return { ok: false, reason: 'no-assignee' };
  const rest = after.slice(1);
  const lower = rest.toLocaleLowerCase();
  const hit = members
    .filter((x) => x.active && (x.named || x.isMe))
    .sort((a, b) => b.name.length - a.name.length)
    .find((x) => {
      const name = x.name.toLocaleLowerCase();
      if (!lower.startsWith(name)) return false;
      const next = lower.charAt(name.length);
      return next === '' || !/[\p{L}\p{N}]/u.test(next);
    });
  const me = members.find((x) => x.isMe);
  const isMe = !hit && me !== undefined && /^me\b/iu.test(rest);
  const who = hit ?? (isMe ? me : undefined);
  if (who === undefined) return { ok: false, reason: 'no-assignee' };
  if (who.role === 'guest') return { ok: false, reason: 'guest' };
  const used = hit ? hit.name.length : 2;
  const title = rest
    .slice(used)
    .replace(/^[\s:,.–—-]+/u, '')
    .trim();
  if (title.length === 0) return { ok: false, reason: 'empty' };
  if (title.length > MAX_TASK_TITLE) return { ok: false, reason: 'too-long' };
  return { ok: true, assignee: who.id, title };
}

export type TaskFilter = 'mine' | 'all' | 'open' | 'done';

export function filterTasks(
  tasks: readonly TeamTask[],
  filter: TaskFilter,
  me: string,
): TeamTask[] {
  switch (filter) {
    case 'mine':
      return tasks.filter((t) => t.assignee === me && !t.done);
    case 'open':
      return tasks.filter((t) => !t.done);
    case 'done':
      return tasks.filter((t) => t.done);
    default:
      return [...tasks];
  }
}

export function filterCounts(tasks: readonly TeamTask[], me: string): Record<TaskFilter, number> {
  return {
    mine: filterTasks(tasks, 'mine', me).length,
    all: tasks.length,
    open: filterTasks(tasks, 'open', me).length,
    done: filterTasks(tasks, 'done', me).length,
  };
}

export interface TaskGroup {
  assignee: string;
  tasks: TeamTask[];
}

/**
 * Tasks grouped by person: me first, then by display name. In a group: open
 * before done, then by due time (none last), then newest first.
 */
export function groupTasks(
  tasks: readonly TeamTask[],
  me: string,
  nameOf: (id: string) => string,
): TaskGroup[] {
  const groups = new Map<string, TeamTask[]>();
  for (const t of tasks) {
    const list = groups.get(t.assignee);
    if (list) list.push(t);
    else groups.set(t.assignee, [t]);
  }
  const order = (a: TeamTask, b: TeamTask) =>
    Number(a.done) - Number(b.done) ||
    (a.due ?? Infinity) - (b.due ?? Infinity) ||
    b.createdAt - a.createdAt ||
    (a.id < b.id ? -1 : 1);
  return [...groups.entries()]
    .map(([assignee, list]) => ({ assignee, tasks: list.sort(order) }))
    .sort((a, b) =>
      a.assignee === me
        ? -1
        : b.assignee === me
          ? 1
          : nameOf(a.assignee).localeCompare(nameOf(b.assignee)),
    );
}

/** Tasks made from one comment or message (its chips). */
export function tasksFromSource(tasks: readonly TeamTask[], owner: string, id: string): TeamTask[] {
  return tasks.filter((t) => t.source?.owner === owner && t.source.id === id);
}
