import type { Json } from '@core/team/canonical';
import { isLive, own, visibleFields, type EntityState } from '@core/team/crdt';
import { entityKey, type EntityRecord, type TeamData } from '@core/team/data';
import { isMemberId } from '@core/team/ids';
import { isAdminRole, type Role } from '@core/team/roles';
import { COLOUR_COUNT } from '@core/teamdraw/record';
import { has, knownFieldsValid, type FieldRule } from '@core/group/fields';
import { recordKey, type Authorization, type KindWrite, type Lane } from '@core/group/registry';

/**
 * Team notes (#706, 2.7.0 PR G8; `docs/design/sync-layer.md` §5.2, security
 * review R-NOTE-1). Owner decision: **a note is a pin that shows its text on
 * the map**, so it adds no new message or envelope type, only two owned
 * `e.set` kinds a 2.6 phone stores, relays and skips:
 *
 * | kind | key | fields | who writes | who deletes |
 * |---|---|---|---|---|
 * | `pnm` pin meta | owned, id = the pin's id | `show` 0/1, `col` 0–7, `fx` expiry (ms), `tx`? edited text, `ll`? moved anchor | the pin's author (guests too) | its author or an admin |
 * | `pnr` "seen" receipt | owned (reader), id = the pin's id | `p` the pin's owner, `at` when seen | anyone but the pin's owner | its writer or an admin |
 *
 * - The pin itself is unchanged: an immutable `msg` on `pin:<owner>:<id>`
 *   carrying `ll` and the note's first text. A 2.6 phone shows it as the pin
 *   it is (its text in the pin card): a correct, older rendering. Deleting a
 *   note is `e.del` of that pin (its author or an admin), on every version.
 * - `pnm` is written by the pin's author only, and only for their own live
 *   pin. Its first write (or a revival) carries `show`, `col` and `fx`.
 * - `fx` is an absolute expiry, after the op's own time and at most
 *   {@link MAX_NOTE_LIFE_MS} after it ("trip end" is the team's end, up to a
 *   year). Like drawings, at most {@link MAX_LIVE_NOTES_PER_AUTHOR} notes per
 *   author are live at an op's time.
 * - `tx` is plain text that is already clean ({@link cleanNoteText}): the
 *   fold refuses any other string, so no phone ever folds a bidi override,
 *   an invisible character or a seventh line. The check is engine-independent
 *   (explicit code point ranges, no Unicode tables), so every phone agrees;
 *   NFC is applied by the writer ({@link prepareNoteText}), never by the fold.
 * - Forward-lenient: a field this version does not know is accepted
 *   (`@core/group/fields`), so a 2.7.x note never vanishes on a 2.7.0 phone.
 */
export const PNM = 'pnm';
export const PNR = 'pnr';
export const NOTE_KINDS: readonly string[] = [PNM, PNR];

/** A note's text, in code points (mockup: "42 / 140"). */
export const MAX_NOTE_CHARS = 140;
/** Lines a note may hold (R-NOTE-1). */
export const MAX_NOTE_LINES = 6;
/** A run of combining marks longer than this is cut (stacked "zalgo" text). */
export const MAX_COMBINING_RUN = 3;
/** Live notes per author at an op's time (as `MAX_LIVE_PER_AUTHOR` for drawings). */
export const MAX_LIVE_NOTES_PER_AUTHOR = 20;
/** The longest life a note may claim: a team lasts at most a year (`lifetime.ts`). */
export const MAX_NOTE_LIFE_MS = 366 * 24 * 3600_000;

const HOUR = 3600_000;

/** "Fades after" (mockup composer): 1 h, 4 h, 1 day, or the team's end. */
export const NOTE_FADES = [
  { id: '1h', label: '1 h', ms: HOUR },
  { id: '4h', label: '4 h', ms: 4 * HOUR },
  { id: '1d', label: '1 day', ms: 24 * HOUR },
  { id: 'trip', label: 'Trip end', ms: null },
] as const;
export type NoteFade = (typeof NOTE_FADES)[number]['id'];
/** Owner Q2 (#706): 4 h. */
export const DEFAULT_NOTE_FADE: NoteFade = '4h';

/**
 * The expiry for a fade choice made `now`: `trip` is the team's end (never
 * past the protocol's cap). Null when that end is already past.
 */
export function noteExpiry(fade: NoteFade, now: number, teamEndsAt: number): number | null {
  const spec = NOTE_FADES.find((f) => f.id === fade) ?? NOTE_FADES[1];
  const at = spec.ms === null ? Math.min(teamEndsAt, now + MAX_NOTE_LIFE_MS) : now + spec.ms;
  return Number.isSafeInteger(Math.floor(at)) && at > now ? Math.floor(at) : null;
}

/**
 * A note placed with the Draw bar's Text tool takes the Style button's fade
 * (a drawing's life: seconds up to 4 h, or never): up to an hour is `1h`, up
 * to 4 h is `4h`, never is the trip's end.
 */
export function noteFadeForDrawing(fadeMs: number | null): NoteFade {
  if (fadeMs === null) return 'trip';
  return fadeMs <= HOUR ? '1h' : '4h';
}

/** The fade choice an expiry set at `from` reads as (nearest preset; `trip` past a day). */
export function fadeOf(expiresAt: number, from: number): NoteFade {
  const life = expiresAt - from;
  if (life > 25 * HOUR) return 'trip';
  if (life > 5 * HOUR) return '1d';
  if (life > 1.5 * HOUR) return '4h';
  return '1h';
}

// ── R-NOTE-1: the sanitiser ─────────────────────────────────────────────────

/**
 * Code points a note never holds: C0/C1 controls (a line feed aside), the
 * Arabic letter mark, zero-width and bidi marks, bidi embeddings, overrides
 * and isolates, invisible operators, the BOM, the Mongolian vowel separator,
 * the soft hyphen, the grapheme joiner, interlinear annotations, tag
 * characters (invisible "ASCII smuggling") and lone surrogates.
 */
function forbidden(cp: number): boolean {
  return (
    (cp <= 0x1f && cp !== 0x0a) ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0xad ||
    cp === 0x34f ||
    cp === 0x61c ||
    cp === 0x180e ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) ||
    (cp >= 0xd800 && cp <= 0xdfff) ||
    cp === 0xfeff ||
    (cp >= 0xfff9 && cp <= 0xfffb) ||
    (cp >= 0xe0000 && cp <= 0xe007f)
  );
}

/** Combining marks (explicit blocks: the same answer on every engine). */
function combining(cp: number): boolean {
  return (
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x483 && cp <= 0x489) ||
    (cp >= 0x591 && cp <= 0x5bd) ||
    (cp >= 0x610 && cp <= 0x61a) ||
    (cp >= 0x64b && cp <= 0x65f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  );
}

/** Space separators, folded to a plain space. */
const SPACES = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;

/**
 * A note's text made clean (R-NOTE-1), deterministic and idempotent: line
 * breaks unified, forbidden code points dropped, combining runs capped,
 * spaces folded and trimmed per line, one blank line at most between lines,
 * at most {@link MAX_NOTE_LINES} lines (the rest joins the last), at most
 * {@link MAX_NOTE_CHARS} code points. No Unicode tables (no NFC, no `\p{}`):
 * the fold's check is this function, and every phone must agree on it.
 */
export function cleanNoteText(raw: string, maxChars: number = MAX_NOTE_CHARS): string {
  const unified = raw.replace(/\r\n?|[\u2028\u2029]/g, '\n').replace(/\t/g, ' ');
  let kept = '';
  let run = 0;
  for (const ch of unified) {
    const cp = ch.codePointAt(0) ?? 0;
    if (forbidden(cp)) continue;
    if (combining(cp)) {
      run += 1;
      if (run > MAX_COMBINING_RUN) continue;
    } else run = 0;
    kept += ch;
  }
  const lines: string[] = [];
  for (const line of kept.split('\n')) {
    const tidy = line.replace(SPACES, ' ').replace(/ {2,}/g, ' ').trim();
    // One blank line at most between two lines, none at the ends.
    if (tidy === '' && (lines.length === 0 || lines[lines.length - 1] === '')) continue;
    lines.push(tidy);
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length > MAX_NOTE_LINES) {
    const rest = lines
      .splice(MAX_NOTE_LINES - 1)
      .filter((l) => l !== '')
      .join(' ');
    lines.push(rest);
  }
  const joined = lines.join('\n');
  const cps = Array.from(joined);
  if (cps.length <= maxChars) return joined;
  return trimEndClean(cps.slice(0, maxChars).join(''));
}

/** Trailing spaces and line breaks off (what a cut may leave). */
const trimEndClean = (s: string) => s.replace(/[ \n]+$/, '');

/** NFC when the engine has it (writers and display only, never the fold). */
function nfc(s: string): string {
  try {
    return s.normalize('NFC');
  } catch {
    return s;
  }
}

/** What a writer sends: NFC, then {@link cleanNoteText}. Empty = nothing to send. */
export function prepareNoteText(raw: string): string {
  return cleanNoteText(nfc(raw));
}

/**
 * A pin's text for display as a note (any length a pin may carry, from any
 * version): prepared, and cut with an ellipsis when it was longer.
 */
export function displayNoteText(raw: string): string {
  const full = cleanNoteText(nfc(raw), Number.MAX_SAFE_INTEGER);
  if (Array.from(full).length <= MAX_NOTE_CHARS) return full;
  return `${cleanNoteText(full, MAX_NOTE_CHARS - 1)}…`;
}

/** The note length a composer counts (code points). */
export const noteLength = (s: string): number => Array.from(s).length;

/** A note text the fold accepts: a non-empty string that is already clean. */
export function validNoteText(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && cleanNoteText(v) === v;
}

// ── Field rules ─────────────────────────────────────────────────────────────

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const time = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** `[lng, lat]` inside the world. */
export function validAnchor(v: unknown): v is [number, number] {
  if (!Array.isArray(v) || v.length !== 2) return false;
  const [lng, lat] = v as unknown[];
  return finite(lng) && finite(lat) && Math.abs(lng) <= 180 && Math.abs(lat) <= 90;
}

const PNM_RULES: Readonly<Record<string, FieldRule>> = {
  show: (v) => v === 0 || v === 1,
  col: (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < COLOUR_COUNT,
  fx: time,
  tx: validNoteText,
  ll: validAnchor,
};
/** A note's first write (or its revival) carries these. */
export const PNM_FIRST: readonly string[] = ['show', 'col', 'fx'];

const PNR_RULES: Readonly<Record<string, FieldRule>> = { p: isMemberId, at: time };

/** `fx`: after the op's own time, and at most {@link MAX_NOTE_LIFE_MS} (+ a minute) after it. */
export function validNoteExpiry(fx: unknown, wall: number): boolean {
  return time(fx) && fx > wall && fx <= wall + MAX_NOTE_LIFE_MS + 60_000;
}

// ── The live cap's index ────────────────────────────────────────────────────

/**
 * Per fold, per author: their notes that are shown, id → expiry. Kept in step
 * by the plug-in's `merged` hook (constant-time authorization, as the drawing
 * index), keyed by the fold's own record index so a fresh fold starts empty.
 */
const live = new WeakMap<object, Map<string, Map<string, number>>>();

function liveOf(view: Readonly<TeamData>): Map<string, Map<string, number>> {
  let m = live.get(view.index);
  if (m === undefined) {
    m = new Map();
    live.set(view.index, m);
  }
  return m;
}

/** Shown notes of one author at `wall` (expired entries pruned). */
function liveCount(mine: Map<string, number> | undefined, wall: number): number {
  if (mine === undefined) return 0;
  for (const [id, x] of mine) if (x <= wall) mine.delete(id);
  return mine.size;
}

/** Keep the live-note index in step with one merged `pnm` record. */
export function reindexNote(view: TeamData, rec: Readonly<EntityRecord>): void {
  if (rec.kind !== PNM || rec.owner === undefined) return;
  const all = liveOf(view);
  const mine = all.get(rec.owner) ?? new Map<string, number>();
  const f = isLive(rec.state) ? visibleFields(rec.state) : {};
  if (f['show'] === 1 && time(f['fx'])) mine.set(rec.id, f['fx']);
  else mine.delete(rec.id);
  all.set(rec.owner, mine);
}

// ── Authorization ───────────────────────────────────────────────────────────

/** The pin's root message, when `owner` has a live pin `id`. */
function pinRoot(view: Readonly<TeamData>, owner: string, id: string): EntityState | undefined {
  const rec = view.entities.get(entityKey('msg', id, owner));
  if (rec === undefined || !isLive(rec.state)) return undefined;
  const f = visibleFields(rec.state);
  return f['th'] === `pin:${owner}:${id}` && validAnchor(f['ll']) ? rec.state : undefined;
}

/** Shape of a note write itself, before any role: `o` only on a delete. */
export function validNoteWrite(w: KindWrite): boolean {
  return NOTE_KINDS.includes(w.kind) && (w.o === undefined || w.op === 'del');
}

/** Authorization of a {@link NOTE_KINDS} write validated by {@link validNoteWrite}. */
export function authorizeNote(w: KindWrite, role: Role, view: Readonly<TeamData>): Authorization {
  if (w.op === 'del') {
    const owner = w.o ?? w.author;
    return owner === w.author || isAdminRole(role) ? { owner } : 'forbidden';
  }
  if (w.kind === PNR) {
    if (!knownFieldsValid(w.f, PNR_RULES) || !has(w.f, 'p') || !has(w.f, 'at')) return 'invalid';
    const pinOwner = w.f['p'] as string;
    // Never a receipt for my own note; only for a pin that exists.
    if (pinOwner === w.author) return 'invalid';
    if (pinRoot(view, pinOwner, w.id) === undefined) return 'forbidden';
    return { owner: w.author };
  }
  if (!knownFieldsValid(w.f, PNM_RULES)) return 'invalid';
  if (has(w.f, 'fx') && !validNoteExpiry(w.f['fx'], w.wall)) return 'invalid';
  // Only the pin's author dresses it as a note, and only a live pin of theirs.
  if (pinRoot(view, w.author, w.id) === undefined) return 'forbidden';
  const cur = view.entities.get(recordKey(true, PNM, w.id, w.author))?.state;
  const shown = cur !== undefined && isLive(cur) ? visibleFields(cur) : undefined;
  if (shown === undefined && !PNM_FIRST.every((k) => has(w.f, k))) return 'invalid';
  const next = (k: string): Json | undefined => (has(w.f, k) ? w.f[k] : own(shown ?? {}, k));
  const fx = next('fx');
  const liveAfter = next('show') === 1 && time(fx) && fx > w.wall;
  if (liveAfter) {
    const mine = liveOf(view).get(w.author);
    const already = (mine?.get(w.id) ?? 0) > w.wall;
    if (!already && liveCount(mine, w.wall) >= MAX_LIVE_NOTES_PER_AUTHOR) return 'forbidden';
  }
  return { owner: w.author };
}

/** Receipts ride the sync lane; note edits go live (§4.4). */
export const noteLane = (kind: string): Lane => (kind === PNR ? 2 : 1);

// ── Writers' bodies ─────────────────────────────────────────────────────────

export interface NoteStyle {
  /** Palette index, 0–7 (`MEMBER_COLORS`). */
  col: number;
  /** Absolute expiry, ms. */
  fx: number;
}

/** The `pnm` that makes pin `id` a note. */
export function noteBody(
  id: string,
  s: NoteStyle,
): { k: string; id: string; f: Record<string, Json> } {
  return { k: PNM, id, f: { show: 1, col: s.col, fx: s.fx } };
}

/** A later edit of my note (text, colour, fade, place). */
export function noteEditBody(
  id: string,
  patch: { tx?: string; col?: number; fx?: number; ll?: [number, number] },
): { k: string; id: string; f: Record<string, Json> } {
  const f: Record<string, Json> = {};
  if (patch.tx !== undefined) f['tx'] = patch.tx;
  if (patch.col !== undefined) f['col'] = patch.col;
  if (patch.fx !== undefined) f['fx'] = patch.fx;
  if (patch.ll !== undefined) f['ll'] = patch.ll;
  return { k: PNM, id, f };
}

/** "I have seen `owner`'s note `id`" (written once, when its card first opens). */
export function seenBody(
  owner: string,
  id: string,
  at: number,
): { k: string; id: string; f: Record<string, Json> } {
  return { k: PNR, id, f: { p: owner, at } };
}

// ── Reading ─────────────────────────────────────────────────────────────────

export interface NoteMeta {
  /** Palette index. */
  col: number;
  /** Expiry, ms. */
  expiresAt: number;
  /** When the current fade was chosen (the `fx` write's time): the life's start. */
  fadeFrom: number;
  /** The edited text, when edited. */
  text: string | null;
  /** When the text was last edited (ms), or null. */
  editedAt: number | null;
  /** The moved anchor, when moved. */
  ll: [number, number] | null;
}

/** `owner`'s pin `id` dressed as a note (shown), or null: a plain pin. */
export function noteMeta(data: TeamData, owner: string, id: string): NoteMeta | null {
  const rec = data.entities.get(recordKey(true, PNM, id, owner));
  if (rec === undefined || !isLive(rec.state)) return null;
  const f = visibleFields(rec.state);
  const col = f['col'];
  const fx = f['fx'];
  if (f['show'] !== 1 || typeof col !== 'number' || !time(fx)) return null;
  const tx = validNoteText(f['tx']) ? f['tx'] : null;
  return {
    col,
    expiresAt: fx,
    fadeFrom: rec.state.fields['fx']?.stamp.wall ?? 0,
    text: tx,
    editedAt: tx === null ? null : (rec.state.fields['tx']?.stamp.wall ?? null),
    ll: validAnchor(f['ll']) ? f['ll'] : null,
  };
}

/** Whether `member` has a receipt in for `owner`'s note `id`. */
export function hasSeen(data: TeamData, member: string, owner: string, id: string): boolean {
  const rec = data.entities.get(recordKey(true, PNR, id, member));
  return rec !== undefined && isLive(rec.state) && visibleFields(rec.state)['p'] === owner;
}
