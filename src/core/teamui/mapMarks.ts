/**
 * What the team draws on the main map beside its layers (#589, mockup
 * `a-map`): comment bubbles next to shared photos, pins with their thread
 * count, and open tasks under what they are anchored to. Pure: positions,
 * counts and "new" (unseen) states; the screen draws them. Caps keep a busy
 * team from flooding the map.
 */
import type { TeamTask } from '@core/team/tasks';
import { isLive } from '@core/team/crdt';
import type { TeamData } from '@core/team/data';
import { entityToComment } from '@core/team/photos';

import type { TeamPhoto } from './comments';
import type { TeamPin } from './pins';
import { unseenCount } from './pins';
import { anchorInfo, type AnchorLookup } from './tasks';

export const MAX_BUBBLES = 40;
export const MAX_PIN_MARKS = 40;
export const MAX_TASK_MARKS = 20;

export interface Said {
  author: string;
  at: number;
}

/** Comments per shared photo (who and when), for the bubbles. */
export function commentsByPhoto(data: TeamData): Map<string, Said[]> {
  const out = new Map<string, Said[]>();
  for (const rec of data.entities.values()) {
    if (rec.kind !== 'comment' || !isLive(rec.state)) continue;
    const c = entityToComment(rec, '');
    if (c === null || c.deletedAt !== undefined) continue;
    const list = out.get(c.photoId);
    const said = { author: c.author.id, at: c.createdAt };
    if (list) list.push(said);
    else out.set(c.photoId, [said]);
  }
  return out;
}

export interface BubbleMark {
  key: string;
  photo: TeamPhoto;
  /** New comments when there are any, else all of them. */
  count: number;
  fresh: boolean;
}

export interface PinMark {
  key: string;
  owner: string;
  id: string;
  lng: number;
  lat: number;
  count: number;
  fresh: boolean;
}

export interface TaskMark {
  key: string;
  lng: number;
  lat: number;
  label: string;
  /** What it hangs under (its offset from the anchor), and its place in a stack there. */
  under: 'photo' | 'pin' | 'point';
  stack: number;
  task: TeamTask;
}

export interface MarksInput {
  photos: readonly TeamPhoto[];
  threads: ReadonlyMap<string, readonly Said[]>;
  pins: readonly TeamPin[];
  tasks: readonly TeamTask[];
  me: string;
  seenAt: (thread: string) => number;
  look: AnchorLookup;
  nameOf: (memberId: string) => string;
}

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function teamMapMarks(input: MarksInput): {
  bubbles: BubbleMark[];
  pins: PinMark[];
  tasks: TaskMark[];
} {
  const { me, seenAt } = input;
  const bubbles: BubbleMark[] = [];
  for (const photo of input.photos) {
    const said = input.threads.get(photo.id);
    if (!said || said.length === 0) continue;
    const fresh = unseenCount(said, me, seenAt(`photo:${photo.id}`));
    bubbles.push({
      key: `${photo.owner}:${photo.id}`,
      photo,
      count: fresh > 0 ? fresh : said.length,
      fresh: fresh > 0,
    });
  }
  bubbles.sort((a, b) => Number(b.fresh) - Number(a.fresh));

  const pins: PinMark[] = input.pins.slice(0, MAX_PIN_MARKS).map((p) => {
    const fresh = unseenCount(p.messages, me, seenAt(`pin:${p.owner}:${p.id}`));
    return {
      key: `${p.owner}:${p.id}`,
      owner: p.owner,
      id: p.id,
      lng: p.lng,
      lat: p.lat,
      count: fresh > 0 ? fresh : p.messages.length,
      fresh: fresh > 0,
    };
  });

  const tasks: TaskMark[] = [];
  const stacks = new Map<string, number>();
  const open = input.tasks
    .filter((t) => !t.done && t.anchor !== null && t.anchor.kind !== 'trail')
    .sort((a, b) => Number(b.assignee === me) - Number(a.assignee === me));
  for (const task of open) {
    if (tasks.length >= MAX_TASK_MARKS) break;
    const where = anchorInfo(task.anchor, input.look);
    if (where.at === null || task.anchor === null || task.anchor.kind === 'trail') continue;
    const spot = `${where.at[0]},${where.at[1]}`;
    const stack = stacks.get(spot) ?? 0;
    stacks.set(spot, stack + 1);
    const who = task.assignee === me ? 'you' : (input.nameOf(task.assignee).split(' ')[0] ?? '');
    tasks.push({
      key: `${task.owner}:${task.id}`,
      lng: where.at[0],
      lat: where.at[1],
      label: `${short(task.title, 22)} · ${who}`,
      under: task.anchor.kind,
      stack,
      task,
    });
  }
  return { bubbles: bubbles.slice(0, MAX_BUBBLES), pins, tasks };
}
