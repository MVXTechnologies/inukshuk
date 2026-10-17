import type { Role } from '@core/team/roles';
import { shortDate } from '@core/library/libraryRows';
import { shortAge } from '@core/teamui/positions';

import {
  actionOf,
  activity,
  recordConflicts,
  reviews,
  type ActivityAction,
  type LibraryHistory,
  type RecordReview,
} from './history';
import { LFO, LIT } from './kinds';
import type { LibraryView } from './tree';

/**
 * What the Share live screens say (2.7.0 #712, G10 mockups): the shared
 * folder's sync line, a row's "who changed it", the Activity feed with what
 * needs a look pinned on top, and People. Pure text from the history and the
 * view; the screens only lay it out.
 */

/** A member's display name (the folder's profiles, else the team's). */
export type NameOf = (memberId: string) => string;

export type SyncTone = 'ok' | 'wait' | 'join';

/** "just now", "2 min ago", "5 h ago", "yesterday", "3 days ago". */
export function agoPhrase(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

/** The second line of a shared folder's header. */
export function syncLine(o: {
  joining?: { from: string };
  waiting: number;
  lastSyncAt?: number;
  now: number;
}): { text: string; tone: SyncTone } {
  if (o.joining !== undefined) return { text: `Joining · from ${o.joining.from}`, tone: 'join' };
  if (o.waiting > 0)
    return {
      text: `${o.waiting} ${o.waiting === 1 ? 'change' : 'changes'} waiting`,
      tone: 'wait',
    };
  if (o.lastSyncAt === undefined) return { text: 'Live', tone: 'ok' };
  return { text: `Synced ${agoPhrase(o.now - o.lastSyncAt)}`, tone: 'ok' };
}

const VERB: Record<ActivityAction, string> = {
  create: 'Added',
  rename: 'Renamed',
  move: 'Moved',
  edit: 'Edited',
  trash: 'Deleted',
  restore: 'Restored',
  purge: 'Deleted for good',
};

function namesList(names: readonly string[]): string {
  const u = [...new Set(names)];
  return u.length <= 2 ? u.join(', ') : `${u.slice(0, 2).join(', ')} +${u.length - 2}`;
}

/**
 * The caption a row in a shared folder gets: "2 versions · Noé, Julie" while
 * one field has two, else "Renamed by Julie · 2 h" when someone else changed
 * it last; undefined when the last change is mine (the usual caption stays).
 */
export function rowNote(
  h: LibraryHistory,
  kind: typeof LFO | typeof LIT,
  rid: string,
  me: string,
  name: NameOf,
  now: number,
): { text: string; conflict: boolean } | undefined {
  const c = recordConflicts(h, kind, rid);
  if (c.length > 0) {
    const who = c.flatMap((x) => [x.kept.write, ...x.others.map((o) => o.write)]);
    return {
      text: `2 versions · ${namesList(who.map((w) => name(w.stamp.author)))}`,
      conflict: true,
    };
  }
  const writes = h.records.get(`${kind}:${rid}`) ?? [];
  const last = writes[writes.length - 1];
  if (last === undefined || last.stamp.author === me || last.fields['cp'] === 1) return undefined;
  const action = actionOf(last, writes.length === 1);
  return {
    text: `${VERB[action]} by ${name(last.stamp.author)} · ${shortAge(now - last.stamp.wall)}`,
    conflict: false,
  };
}

/** A bit of an Activity line; `b` is bold (people and items). */
export interface Part {
  t: string;
  b?: boolean;
}

export interface ActivityLine {
  key: string;
  author: string;
  parts: Part[];
  when: string;
  /** What needs a look: Review (two versions) or Restore (a delete beat an edit). */
  review?: { action: 'review' | 'restore'; kind: typeof LFO | typeof LIT; id: string };
}

export interface ActivityFeed {
  pinned: ActivityLine[];
  days: { label: string; lines: ActivityLine[] }[];
  /** Who appears, for the filter chips (me excluded), in order of appearance. */
  people: string[];
}

const LOWER: Record<ActivityAction, string> = {
  create: 'added',
  rename: 'renamed',
  move: 'moved',
  edit: 'edited',
  trash: 'deleted',
  restore: 'restored',
  purge: 'deleted for good',
};

function itemName(view: LibraryView, kind: string, id: string, h: LibraryHistory): string {
  const n = kind === LFO ? view.folders.get(id) : view.items.get(id);
  if (n !== undefined && n.name !== '') return n.name;
  // Purged: the last name it was written with.
  const ws = h.records.get(`${kind}:${id}`) ?? [];
  for (let i = ws.length - 1; i >= 0; i--) {
    const v = ws[i]!.fields['n'];
    if (typeof v === 'string') return v;
  }
  return 'an item';
}

function dayLabel(at: number, now: number): string {
  const d = new Date(at);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (at >= startOfToday) return 'Today';
  if (at >= startOfToday - 24 * 60 * 60 * 1000) return 'Yesterday';
  return shortDate(d.getTime(), now);
}

function pinnedLine(
  r: RecordReview,
  view: LibraryView,
  h: LibraryHistory,
  me: string,
  name: NameOf,
  now: number,
): ActivityLine {
  const item = itemName(view, r.kind, r.id, h);
  const who = (id: string) => (id === me ? 'You' : name(id));
  if (r.beaten !== undefined) {
    const deleter = r.beaten.removal.stamp.author;
    const editors = [...new Set(r.beaten.edits.map((e) => e.stamp.author))];
    const editor = editors.includes(me) ? 'you were' : `${who(editors[0] ?? deleter)} was`;
    return {
      key: `beaten:${r.kind}:${r.id}`,
      author: deleter,
      parts: [
        { t: who(deleter), b: true },
        { t: ' deleted ' },
        { t: item, b: true },
        { t: ` while ${editor} editing it` },
      ],
      when: shortAge(now - r.at.wall),
      review: { action: 'restore', kind: r.kind, id: r.id },
    };
  }
  const c = r.conflicts[0]!;
  const authors = [
    ...new Set([c.kept.write.stamp.author, ...c.others.map((o) => o.write.stamp.author)]),
  ];
  const verb = c.field === 'n' ? 'renamed' : 'edited';
  const parts: Part[] = [];
  authors.slice(0, 2).forEach((a, i) => {
    if (i > 0) parts.push({ t: ' and ' });
    parts.push({ t: who(a), b: true });
  });
  if (authors.length > 2) parts.push({ t: ` +${authors.length - 2}` });
  parts.push({ t: ` both ${verb} ` }, { t: item, b: true });
  return {
    key: `conflict:${r.kind}:${r.id}`,
    author: c.kept.write.stamp.author,
    parts,
    when: shortAge(now - r.at.wall),
    review: { action: 'review', kind: r.kind, id: r.id },
  };
}

/** The Activity screen: what needs a look on top, then every change by day (newest first). */
export function activityFeed(
  h: LibraryHistory,
  view: LibraryView,
  me: string,
  name: NameOf,
  now: number,
  author?: string,
): ActivityFeed {
  const who = (id: string) => (id === me ? 'You' : name(id));
  const pinned = reviews(h)
    .map((r) => pinnedLine(r, view, h, me, name, now))
    .filter((l) => author === undefined || l.author === author);
  const all = activity(h, now);
  const people: string[] = [];
  for (const e of all) if (e.author !== me && !people.includes(e.author)) people.push(e.author);
  const days: ActivityFeed['days'] = [];
  for (const e of all) {
    if (author !== undefined && e.author !== author) continue;
    // The folder's own creation reads as sharing it.
    const isRoot = e.id === view.root;
    const parts: Part[] =
      isRoot && e.action === 'create'
        ? [{ t: who(e.author), b: true }, { t: ' shared this folder' }]
        : [
            { t: who(e.author), b: true },
            { t: ` ${LOWER[e.action]} ` },
            { t: itemName(view, e.kind, e.id, h), b: true },
          ];
    const label = dayLabel(e.at.wall, now);
    let day = days[days.length - 1];
    if (day === undefined || day.label !== label) {
      day = { label, lines: [] };
      days.push(day);
    }
    day.lines.push({ key: e.opId, author: e.author, parts, when: shortAge(now - e.at.wall) });
  }
  return { pinned, days, people };
}

export interface PersonRow {
  id: string;
  name: string;
  /** "Owner", "Manager", "Can edit", "Can view". */
  detail: string;
  role?: Role;
  isMe: boolean;
  /** Not in the folder yet (kept for the row shape; always false since folders stand alone). */
  pending: boolean;
}

/** The library's names for the v1 ranks. */
export function roleLabel(role: Role): string {
  return role === 'owner'
    ? 'Owner'
    : role === 'admin'
      ? 'Manager'
      : role === 'member'
        ? 'Can edit'
        : 'Can view';
}

const RANK: Record<Role, number> = { owner: 0, admin: 1, member: 2, guest: 3 };

/** People in a shared folder: active members, me first, then by role and name. */
export function peopleRows(
  members: Iterable<{ id: string; role: Role; status: string }>,
  me: string,
  name: NameOf,
): PersonRow[] {
  const rows: PersonRow[] = [];
  for (const m of members) {
    if (m.status !== 'active') continue;
    rows.push({
      id: m.id,
      name: m.id === me ? 'You' : name(m.id),
      detail: roleLabel(m.role),
      role: m.role,
      isMe: m.id === me,
      pending: false,
    });
  }
  rows.sort(
    (a, b) =>
      Number(b.isMe) - Number(a.isMe) ||
      RANK[a.role!] - RANK[b.role!] ||
      a.name.localeCompare(b.name),
  );
  return rows;
}

/** "4 can edit · 2 can view" (managers count as editors). */
export function peopleSummary(rows: readonly PersonRow[]): string {
  const edit = rows.filter((r) => !r.pending && r.role !== undefined && r.role !== 'guest').length;
  const view = rows.filter((r) => r.role === 'guest').length;
  return view > 0 ? `${edit} can edit · ${view} can view` : `${edit} can edit`;
}
