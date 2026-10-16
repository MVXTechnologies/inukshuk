/**
 * Team tasks in the UI (#589): the `+task @name …` command in comments, and
 * the task list's filters and groups. Pure. The task entity and its rules
 * are `@core/team/tasks`.
 */
import { MAX_TASK_TITLE, type TaskAnchor, type TeamTask } from '@core/team/tasks';

import type { MemberRow } from './view';

export type TaskCommand =
  | {
      ok: true;
      assignee: string;
      title: string;
      /** Where `+task @Name` sits in the text (to highlight it). */
      span: [number, number];
    }
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
  // "@Julie" for "Julie Tremblay": a first name that only one active member has.
  const first = /^[\p{L}\p{N}'’-]+/u.exec(rest)?.[0];
  const byFirst =
    hit || isMe || first === undefined
      ? []
      : members.filter(
          (x) =>
            x.active &&
            (x.named || x.isMe) &&
            x.name.split(/\s/u)[0]?.toLocaleLowerCase() === first.toLocaleLowerCase(),
        );
  const who = hit ?? (isMe ? me : byFirst.length === 1 ? byFirst[0] : undefined);
  if (who === undefined) return { ok: false, reason: 'no-assignee' };
  if (who.role === 'guest') return { ok: false, reason: 'guest' };
  const used = hit ? hit.name.length : isMe ? 2 : (first?.length ?? 0);
  const title = rest
    .slice(used)
    .replace(/^[\s:,.–—-]+/u, '')
    .trim();
  if (title.length === 0) return { ok: false, reason: 'empty' };
  if (title.length > MAX_TASK_TITLE) return { ok: false, reason: 'too-long' };
  const base = m.index + m[0].length;
  const at = base + (text.length - base - after.length);
  const start = m.index + m[1]!.length;
  return { ok: true, assignee: who.id, title, span: [start, at + 1 + used] };
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

/** What a task's anchor points at, looked up in the team's data. */
export interface AnchorLookup {
  photo(
    owner: string,
    id: string,
  ): { lng: number; lat: number; caption: string | null } | undefined;
  pin(owner: string, id: string): { lng: number; lat: number; text: string } | undefined;
  trail(owner: string, id: string): { name: string; start: [number, number] | null } | undefined;
}

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A task anchor's label ("Photo · Summit") and where it is on the map, if anywhere. */
export function anchorInfo(
  anchor: TaskAnchor | null,
  look: AnchorLookup,
): { label: string; at: [number, number] | null } {
  if (anchor === null) return { label: 'No place', at: null };
  switch (anchor.kind) {
    case 'point':
      return { label: 'A place on the map', at: [anchor.lng, anchor.lat] };
    case 'photo': {
      const p = look.photo(anchor.owner, anchor.id);
      if (!p) return { label: 'A photo no longer shared', at: null };
      return {
        label: p.caption ? `Photo · ${short(p.caption, 40)}` : 'A shared photo',
        at: [p.lng, p.lat],
      };
    }
    case 'pin': {
      const p = look.pin(anchor.owner, anchor.id);
      if (!p) return { label: 'A removed pin', at: null };
      return { label: `Pin · ${short(p.text, 40)}`, at: [p.lng, p.lat] };
    }
    case 'trail': {
      const tr = look.trail(anchor.owner, anchor.id);
      if (!tr) return { label: 'A trail no longer shared', at: null };
      return { label: `Trail · ${short(tr.name, 40)}`, at: tr.start };
    }
  }
}

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTH = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const pad2 = (n: number) => String(n).padStart(2, '0');
const dayStart = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
/** Whole local days from `now`'s day to `ms`'s (DST-proof: calendar days, not 24 h). */
const daysApart = (ms: number, now: number) => {
  const a = new Date(dayStart(now));
  const b = new Date(dayStart(ms));
  return Math.round(
    (Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) -
      Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) /
      (24 * HOUR_MS),
  );
};

/**
 * A task's due time on screen (#746), in local time: "Today 16:00",
 * "Tomorrow 08:30", "Yesterday 18:00", a weekday within the coming week
 * ("Sat 09:00"), else the date ("Oct 30 16:00").
 */
export function dueLabel(due: number, now: number): string {
  const d = new Date(due);
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const days = daysApart(due, now);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days === -1) return `Yesterday ${time}`;
  if (days > 1 && days < 7) return `${WEEKDAY[d.getDay()]} ${time}`;
  return `${MONTH[d.getMonth()]} ${d.getDate()} ${time}`;
}

/** "In 1 h": an hour from now, to the minute. */
export function inOneHour(now: number): number {
  return Math.round((now + HOUR_MS) / MIN_MS) * MIN_MS;
}

/** Where "Pick…" starts: the due time already set, else the next full hour after an hour from now. */
export function pickStart(due: number | null, now: number): number {
  if (due !== null) return due;
  return Math.ceil((now + HOUR_MS) / HOUR_MS) * HOUR_MS;
}

/** The step of the time stepper in "Pick…". */
export const DUE_STEP_MIN = 15;

/**
 * Move a due time by whole local days (same clock time, across DST) or by
 * minutes (snapped to {@link DUE_STEP_MIN}). Never before now.
 */
export function shiftDue(
  due: number,
  by: { days?: number; minutes?: number },
  now: number,
): number {
  const d = new Date(due);
  if (by.days) d.setDate(d.getDate() + by.days);
  let out = d.getTime();
  if (by.minutes) {
    const step = DUE_STEP_MIN * MIN_MS;
    out = Math.round((out + by.minutes * MIN_MS) / step) * step;
  }
  return out < now ? due : out;
}
