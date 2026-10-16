/**
 * Notes on the map (#706, mockups `#f706`): what the callouts, the note card,
 * the arrival snackbar and the note list show. Pure: fade, unread, ages and
 * time left, the list's sections and filters, "Seen by", and how callouts
 * collapse into tiles when they would overlap or the map is zoomed out.
 */
import { hasSeen } from '@core/domains/team/notes';
import type { TeamData } from '@core/team/data';
import { hasCap, NOTE_CAP } from '@core/teamdraw/caps';
import { toWorld } from '@core/teamdraw/screen';

import type { PinNote, TeamPin } from './pins';

/** A note fades over the last fifth of its life (mockup: "in the last 20 %"). */
export const FADE_TAIL = 0.2;
/** …down to this opacity, then disappears at expiry on every phone. */
export const FADED_OPACITY = 0.48;
/** Faded notes stay listed this long after they expire ("Faded · last 24 h"). */
export const FADED_LIST_MS = 24 * 3600_000;
/** Below this zoom (about 1:50 000) notes collapse to tiles (owner Q4). */
export const NOTE_COLLAPSE_ZOOM = 13;
/** Callouts closer than this on screen (dp) collapse into one tile. */
export const CALLOUT_SPAN = { w: 150, h: 56 } as const;
/** Tiles closer than this on screen (dp) merge. */
export const TILE_SPAN = 44;
/** At most this many callouts or tiles on the map (the newest win). */
export const MAX_NOTE_MARKS = 40;

/** A pin that is a note. */
export type NotePin = TeamPin & { note: PinNote };

export const isNote = (p: TeamPin): p is NotePin => p.note !== null;

/** Shown on the map now (before its expiry). */
export const noteShown = (n: PinNote, now: number): boolean => now < n.expiresAt;

/** Fraction of its life left, 0–1. */
export function lifeLeft(n: PinNote, now: number): number {
  const life = n.expiresAt - n.fadeFrom;
  if (life <= 0) return now < n.expiresAt ? 1 : 0;
  return Math.min(1, Math.max(0, (n.expiresAt - now) / life));
}

/** Its opacity on the map: 1, then down to {@link FADED_OPACITY} over the last fifth. */
export function noteOpacity(n: PinNote, now: number): number {
  const left = lifeLeft(n, now);
  if (left >= FADE_TAIL) return 1;
  const k = left / FADE_TAIL;
  return Math.round((FADED_OPACITY + (1 - FADED_OPACITY) * k) * 100) / 100;
}

/** A note I have not opened since it had news (the orange dot). Never my own. */
export function noteUnread(p: NotePin, me: string, seenAt: (thread: string) => number): boolean {
  return p.owner !== me && seenAt(`pin:${p.owner}:${p.id}`) < p.note.newsAt;
}

/** "now", "12 min", "1 h", "3 h 40", "22 h", "2 d": a note's age or time left. */
export function noteSpan(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h >= 48) return `${Math.floor(h / 24)} d`;
  const mm = m % 60;
  return h >= 10 || mm < 5 ? `${h} h` : `${h} h ${String(mm).padStart(2, '0')}`;
}

// ── "Seen by 4 of 5" ────────────────────────────────────────────────────────

export interface SeenCount {
  /** Members (not its author) whose "seen" receipt is in. */
  seen: number;
  /** Members that can send one: they advertise notes, or already sent one. */
  capable: number;
}

/** Who has opened `owner`'s note `id`, among the active members (ids) other than its author. */
export function seenCount(
  data: TeamData,
  owner: string,
  id: string,
  activeMembers: readonly string[],
  now: number,
): SeenCount {
  let seen = 0;
  let capable = 0;
  for (const m of activeMembers) {
    if (m === owner) continue;
    const got = hasSeen(data, m, owner, id);
    if (got) seen += 1;
    if (got || hasCap(data, m, now, NOTE_CAP)) capable += 1;
  }
  return { seen, capable };
}

/** "4 of 5", or "—" while no other phone can say. */
export const seenLine = (c: SeenCount): string =>
  c.capable === 0 ? '—' : `${c.seen} of ${c.capable}`;

// ── The note list (Team panel › Notes) ──────────────────────────────────────

export type NoteFilter = 'all' | 'new' | 'mine';

export interface NoteRow {
  pin: NotePin;
  unread: boolean;
  mine: boolean;
  /** Expired (listed under "Faded · last 24 h"). */
  faded: boolean;
}

export interface NoteSections {
  fresh: NoteRow[];
  earlier: NoteRow[];
  faded: NoteRow[];
  counts: Record<NoteFilter, number>;
}

const newest = (a: NoteRow, b: NoteRow) =>
  b.pin.note.newsAt - a.pin.note.newsAt || (a.pin.id < b.pin.id ? -1 : 1);

/**
 * The list's sections: New (unread, live), Earlier (read or mine, live), and
 * Faded (expired within the last day), each newest first, under a filter.
 */
export function noteSections(
  pins: readonly TeamPin[],
  me: string,
  seenAt: (thread: string) => number,
  now: number,
  filter: NoteFilter,
): NoteSections {
  const rows: NoteRow[] = [];
  for (const p of pins) {
    if (!isNote(p)) continue;
    const faded = !noteShown(p.note, now);
    if (faded && now - p.note.expiresAt > FADED_LIST_MS) continue;
    rows.push({ pin: p, unread: !faded && noteUnread(p, me, seenAt), mine: p.owner === me, faded });
  }
  const liveRows = rows.filter((r) => !r.faded);
  const counts = {
    all: liveRows.length,
    new: liveRows.filter((r) => r.unread).length,
    mine: liveRows.filter((r) => r.mine).length,
  };
  const keep = (r: NoteRow) => filter === 'all' || (filter === 'new' ? r.unread : r.mine);
  const pick = (f: (r: NoteRow) => boolean) => rows.filter((r) => f(r) && keep(r)).sort(newest);
  return {
    fresh: pick((r) => !r.faded && r.unread),
    earlier: pick((r) => !r.faded && !r.unread),
    faded: filter === 'new' ? [] : pick((r) => r.faded),
    counts,
  };
}

/** A note's news as one key: a new note, or new text, is a new key. */
export const newsKey = (p: NotePin): string => `${p.owner}:${p.id}:${p.note.newsAt}`;

/**
 * The newest teammate's note I have not opened whose news is not in `known`
 * (what was already there, or already announced), if any.
 */
export function noteArrival(
  pins: readonly TeamPin[],
  me: string,
  seenAt: (thread: string) => number,
  known: ReadonlySet<string>,
  now: number,
): NotePin | null {
  let best: NotePin | null = null;
  for (const p of pins) {
    if (!isNote(p) || !noteShown(p.note, now) || known.has(newsKey(p))) continue;
    if (!noteUnread(p, me, seenAt)) continue;
    if (best === null || p.note.newsAt > best.note.newsAt) best = p;
  }
  return best;
}

// ── On the map: callouts and tiles ──────────────────────────────────────────

export type NoteMark =
  | { kind: 'callout'; key: string; pin: NotePin }
  | {
      kind: 'tile';
      key: string;
      lng: number;
      lat: number;
      /** The newest note's colour (palette index). */
      color: number;
      pins: NotePin[];
      /** Any of them unread. */
      unread: boolean;
    };

/**
 * What the map draws for the live notes at `zoom`: a callout per note, or a
 * tile with a count where callouts would overlap on screen, and only tiles
 * below {@link NOTE_COLLAPSE_ZOOM}. Greedy in newest-first order (a newer
 * note keeps its callout), so it is the same for the same notes and zoom.
 */
export function noteMarks(
  pins: readonly TeamPin[],
  zoom: number,
  now: number,
  unread: (p: NotePin) => boolean,
): NoteMark[] {
  const live = pins
    .filter((p): p is NotePin => isNote(p) && noteShown(p.note, now))
    .sort((a, b) => b.note.newsAt - a.note.newsAt || (a.id < b.id ? -1 : 1));
  const collapsed = zoom < NOTE_COLLAPSE_ZOOM;
  const span = collapsed ? { w: TILE_SPAN, h: TILE_SPAN } : CALLOUT_SPAN;
  const groups: { at: [number, number]; pins: NotePin[] }[] = [];
  for (const p of live) {
    const at = toWorld([p.lng, p.lat], zoom);
    const g = groups.find(
      (x) => Math.abs(x.at[0] - at[0]) < span.w && Math.abs(x.at[1] - at[1]) < span.h,
    );
    if (g) g.pins.push(p);
    else if (groups.length < MAX_NOTE_MARKS) groups.push({ at, pins: [p] });
  }
  return groups.map((g) => {
    const head = g.pins[0]!;
    const key = `${head.owner}:${head.id}`;
    if (!collapsed && g.pins.length === 1) return { kind: 'callout', key, pin: head };
    return {
      kind: 'tile',
      key: `tile:${key}`,
      lng: head.lng,
      lat: head.lat,
      color: head.note.color,
      pins: g.pins,
      unread: g.pins.some(unread),
    };
  });
}
