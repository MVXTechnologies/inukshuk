import type { Json } from './canonical';
import { isLive, lastWrite, visibleFields } from './crdt';
import { compareStamp } from './hlc';
import type { EntityRecord, TeamData } from './data';
import { isMemberId, isShortId } from './ids';
import { isAdminRole, type Role } from './roles';

/**
 * Team tasks (#589): a to-do assigned to one member, usually anchored to a
 * shared photo, a pin, a trail or a point.
 *
 * A task is an **owned** entity, keyed `(task, creator, id)`, so nobody can
 * take one over by writing its id. The fold (`data.ts`) authorizes each write
 * by the author's role at that point:
 *
 * - its creator writes any field; admins write any field of any task;
 * - its current assignee may write only the status (`done`, `dby`, `dat`);
 * - guests write no tasks;
 * - the creator or an admin deletes it.
 *
 * Every field is validated on every write; `dby` ("done by") must be the
 * writing author, so nobody can mark a task done in someone else's name.
 */
export const MAX_TASK_TITLE = 500;

export const TASK_FIELDS = [
  'title',
  'assignee',
  'due',
  'ak',
  'ao',
  'ai',
  'la',
  'lo',
  'sc',
  'so',
  'done',
  'dby',
  'dat',
] as const;
/** The fields an assignee may write: the status. */
export const TASK_STATUS_FIELDS: readonly string[] = ['done', 'dby', 'dat'];

export const ANCHOR_KINDS = ['photo', 'pin', 'trail', 'point'] as const;
export type AnchorKind = (typeof ANCHOR_KINDS)[number];

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const time = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

function validField(name: string, v: Json, author: string): boolean {
  switch (name) {
    case 'title':
      return typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_TASK_TITLE;
    case 'assignee':
    case 'ao':
    case 'so':
      return isMemberId(v);
    case 'due':
      return v === null || time(v);
    case 'ak':
      return typeof v === 'string' && (ANCHOR_KINDS as readonly string[]).includes(v);
    case 'ai':
    case 'sc':
      return isShortId(v);
    case 'la':
      return finite(v) && Math.abs(v) <= 90;
    case 'lo':
      return finite(v) && Math.abs(v) <= 180;
    case 'done':
      return typeof v === 'boolean';
    case 'dby':
      return v === author || v === null;
    case 'dat':
      return v === null || time(v);
    default:
      return false;
  }
}

/**
 * Whether a task write's fields are all known and well-formed for this author.
 * The status is written whole (review: "done by" showing the wrong person):
 * `done: true` with `dby` = the author and `dat`; `done: false` with
 * `dby: null, dat: null`; never `dby`/`dat` without `done`.
 */
export function validTaskFields(f: Record<string, Json>, author: string): boolean {
  if (!Object.entries(f).every(([name, v]) => validField(name, v, author))) return false;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(f, k);
  if (!has('done')) return !has('dby') && !has('dat');
  if (!has('dby') || !has('dat')) return false;
  return f['done'] === true
    ? f['dby'] === author && f['dat'] !== null
    : f['dby'] === null && f['dat'] === null;
}

/** Whether a write touches only the status (what an assignee may do). */
export function isTaskStatusUpdate(f: Record<string, Json>): boolean {
  return Object.keys(f).every((k) => TASK_STATUS_FIELDS.includes(k));
}

export type TaskAnchor =
  | { kind: 'photo' | 'pin' | 'trail'; owner: string; id: string }
  | { kind: 'point'; lat: number; lng: number };

export interface TeamTask {
  id: string;
  /** The creator (part of the key). */
  owner: string;
  title: string;
  assignee: string;
  due: number | null;
  anchor: TaskAnchor | null;
  /** The comment or message it was made from (`+task`), if any. */
  source: { owner: string; id: string } | null;
  done: boolean;
  doneBy: string | null;
  doneAt: number | null;
  createdAt: number;
  updatedAt: number;
  /**
   * Its status was written before its latest reassignment, in the team's
   * order (a former assignee's late, or backdated, completion): shown as
   * "completed before reassignment" (review: the accepted HLC residual).
   */
  doneBeforeReassignment: boolean;
}

export interface NewTask {
  title: string;
  assignee: string;
  due?: number | null;
  anchor?: TaskAnchor | null;
  source?: { owner: string; id: string } | null;
}

/** A new task's fields (validated by the caller with {@link validTaskFields}). */
export function taskFields(t: NewTask): Record<string, Json> {
  const f: Record<string, Json> = {
    title: t.title.trim(),
    assignee: t.assignee,
    done: false,
    dby: null,
    dat: null,
  };
  if (t.due != null) f['due'] = t.due;
  const a = t.anchor;
  if (a) {
    f['ak'] = a.kind;
    if (a.kind === 'point') {
      f['la'] = a.lat;
      f['lo'] = a.lng;
    } else {
      f['ao'] = a.owner;
      f['ai'] = a.id;
    }
  }
  if (t.source) {
    f['so'] = t.source.owner;
    f['sc'] = t.source.id;
  }
  return f;
}

/** The status write that marks a task done (or open again). */
export function statusFields(done: boolean, me: string, now: number): Record<string, Json> {
  return done ? { done: true, dby: me, dat: now } : { done: false, dby: null, dat: null };
}

function anchorOf(f: Record<string, Json>): TaskAnchor | null {
  const ak = f['ak'];
  if (ak === 'point') {
    const la = f['la'];
    const lo = f['lo'];
    return finite(la) && finite(lo) ? { kind: 'point', lat: la, lng: lo } : null;
  }
  if (ak === 'photo' || ak === 'pin' || ak === 'trail') {
    const ao = f['ao'];
    const ai = f['ai'];
    return typeof ao === 'string' && typeof ai === 'string'
      ? { kind: ak, owner: ao, id: ai }
      : null;
  }
  return null;
}

/** One task record as a task, or null when it is deleted or incomplete. */
export function entityToTask(rec: EntityRecord): TeamTask | null {
  if (rec.kind !== 'task' || rec.owner === undefined || rec.state.created === undefined)
    return null;
  if (!isLive(rec.state)) return null;
  const f = visibleFields(rec.state);
  const title = f['title'];
  const assignee = f['assignee'];
  if (typeof title !== 'string' || typeof assignee !== 'string') return null;
  const so = f['so'];
  const sc = f['sc'];
  const done = f['done'] === true;
  const doneReg = rec.state.fields['done'];
  const toReg = rec.state.fields['assignee'];
  return {
    id: rec.id,
    owner: rec.owner,
    title,
    assignee,
    due: time(f['due']) ? (f['due'] as number) : null,
    anchor: anchorOf(f),
    source: typeof so === 'string' && typeof sc === 'string' ? { owner: so, id: sc } : null,
    done,
    doneBy: done && typeof f['dby'] === 'string' ? f['dby'] : null,
    doneAt: done && time(f['dat']) ? (f['dat'] as number) : null,
    createdAt: rec.state.created.wall,
    updatedAt: lastWrite(rec.state)?.wall ?? rec.state.created.wall,
    doneBeforeReassignment:
      done &&
      doneReg !== undefined &&
      toReg !== undefined &&
      compareStamp(doneReg.stamp, toReg.stamp) < 0,
  };
}

/** Every live task, newest first. */
export function teamTasks(data: TeamData): TeamTask[] {
  const out: TeamTask[] = [];
  for (const rec of data.entities.values()) {
    const t = entityToTask(rec);
    if (t) out.push(t);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1));
}

/** Whether `me` (holding `role`) may mark this task done or open again. */
export function canCompleteTask(task: TeamTask, me: string, role: Role | undefined): boolean {
  if (role === undefined || role === 'guest') return false;
  return task.owner === me || task.assignee === me || isAdminRole(role);
}

/** Whether `me` may edit (reassign, rename) or delete this task. */
export function canEditTask(task: TeamTask, me: string, role: Role | undefined): boolean {
  if (role === undefined || role === 'guest') return false;
  return task.owner === me || isAdminRole(role);
}
