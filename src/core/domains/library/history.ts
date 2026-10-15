import type { Json } from '@core/team/canonical';
import { isLive, visibleFields } from '@core/team/crdt';
import type { Stamp } from '@core/team/hlc';
import { parseKindWrite, type Decode, type TeamData } from '@core/team/data';
import type { TeamState } from '@core/team/membership';
import {
  BASE_FIELD,
  beatenEdits,
  compareWrites,
  conflicts,
  EMPTY_BASE,
  parseBase,
  silentMerges,
  type BeatenEdits,
  type FieldConflict,
  type Removal,
  type SilentMerge,
  type Write,
} from '@core/group/conflicts';

import { CURSOR_ID, LAC, LCM, LFO, LIT } from './kinds';

/**
 * The library's history (2.7.0 #712): the op log *is* the history (security
 * review §4.4). From the group's accepted data ops it rebuilds, per tree
 * record, every write in fold order; from those, the Activity feed, open
 * conflicts, deletes that beat an offline edit, and the "to review" count.
 * Pure: the data layer passes the replica's state, data view and decoder.
 */

/** One accepted write to a folder or item, with its author and what it changed. */
export interface LibWrite extends Write {
  kind: typeof LFO | typeof LIT;
  /** The record id. */
  rid: string;
}

export interface LibComment {
  id: string;
  author: string;
  stamp: Stamp;
  /** The record it is about. */
  on: string;
  tx: string;
}

export interface LibraryHistory {
  /** Writes per record key (`lfo:<id>` / `lit:<id>`), in fold order. */
  records: ReadonlyMap<string, readonly LibWrite[]>;
  /** Every tree write, in fold order. */
  writes: readonly LibWrite[];
  /** Live comments, in fold order. */
  comments: readonly LibComment[];
}

export const historyKey = (kind: string, id: string): string => `${kind}:${id}`;

/** One decoded data op, as the history reads it. */
export interface HistoryOp {
  id: string;
  stamp: Stamp;
  t: 'e.set' | 'e.del';
  body: Json;
}

/**
 * Accepted `e.set` / `e.del` ops of a group, decoded, in fold order: what
 * {@link buildHistory} takes. `data` tells which ops the fold kept.
 */
export function historyOps(
  state: Readonly<TeamState>,
  data: Readonly<TeamData>,
  decode: Decode,
): HistoryOp[] {
  const skipped = new Set(data.skipped.map((s) => s.id));
  const out: HistoryOp[] = [];
  for (const op of state.data) {
    const t = op.env.t;
    if ((t !== 'e.set' && t !== 'e.del') || skipped.has(op.id)) continue;
    const body = decode(op);
    if (body !== undefined) out.push({ id: op.id, stamp: op.stamp, t, body });
  }
  return out;
}

/**
 * The history of accepted library ops (fold order in, fold order out). Ops
 * of other kinds are ignored; a comment deleted later is dropped.
 */
export function buildHistory(ops: readonly HistoryOp[]): LibraryHistory {
  const records = new Map<string, LibWrite[]>();
  const writes: LibWrite[] = [];
  const comments = new Map<string, LibComment>();
  for (const op of ops) {
    const b = parseKindWrite(op.t, op.body);
    if (b === undefined) continue;
    if (b.k === LCM) {
      const key = `${b.o ?? op.stamp.author}:${b.id}`;
      if (op.t === 'e.del') comments.delete(key);
      else {
        const prev = comments.get(key);
        const f = b.f ?? {};
        const on = typeof f['on'] === 'string' ? f['on'] : prev?.on;
        const tx = typeof f['tx'] === 'string' ? f['tx'] : prev?.tx;
        if (on !== undefined && tx !== undefined)
          comments.set(key, { id: b.id, author: op.stamp.author, stamp: op.stamp, on, tx });
      }
      continue;
    }
    if (b.k !== LFO && b.k !== LIT) continue;
    const fields: Record<string, Json> = { ...(b.f ?? {}) };
    const base = parseBase(fields[BASE_FIELD]) ?? EMPTY_BASE;
    delete fields[BASE_FIELD];
    const w: LibWrite = { id: op.id, stamp: op.stamp, fields, base, kind: b.k, rid: b.id };
    if (op.t === 'e.del') w.del = true;
    const key = historyKey(b.k, b.id);
    const list = records.get(key);
    if (list === undefined) records.set(key, [w]);
    else list.push(w);
    writes.push(w);
  }
  return { records, writes, comments: [...comments.values()] };
}

/** How a tree write affects the trash (`rm` flag; a purge is not a removal: it is final). */
export function removalOf(w: Write): Removal {
  const rm = w.fields['rm'];
  return rm === 1 ? 'remove' : rm === 0 ? 'restore' : undefined;
}

/** Fields whose concurrent writes are not "conflicts" (the trash flag is decided by {@link beatenEdits}). */
export const NO_CONFLICT_FIELDS: ReadonlySet<string> = new Set(['rm']);

/** Open conflicts of one record. */
export function recordConflicts(h: LibraryHistory, kind: string, id: string): FieldConflict[] {
  const ws = h.records.get(historyKey(kind, id));
  return ws === undefined ? [] : conflicts(ws, NO_CONFLICT_FIELDS);
}

/** "Also merged, no conflict" for one record. */
export function recordMerges(h: LibraryHistory, kind: string, id: string): SilentMerge[] {
  const ws = h.records.get(historyKey(kind, id));
  return ws === undefined ? [] : silentMerges(ws, NO_CONFLICT_FIELDS);
}

/** Edits a soft delete of this record beat (Restore brings the record back with them). */
export function recordBeaten(h: LibraryHistory, kind: string, id: string): BeatenEdits | undefined {
  const ws = h.records.get(historyKey(kind, id));
  return ws === undefined ? undefined : beatenEdits(ws, removalOf);
}

export interface RecordReview {
  kind: typeof LFO | typeof LIT;
  id: string;
  conflicts: FieldConflict[];
  beaten?: BeatenEdits;
  /** The newest write involved: what the activity cursor is compared with. */
  at: Stamp;
}

/**
 * Every record that needs a look: open conflicts and deletes that beat an
 * edit, newest first. Purged records are left out (nothing to restore).
 */
export function reviews(h: LibraryHistory): RecordReview[] {
  const out: RecordReview[] = [];
  for (const ws of h.records.values()) {
    const first = ws[0]!;
    if (ws.some((w) => w.del)) continue;
    const c = conflicts(ws, NO_CONFLICT_FIELDS);
    const beaten = beatenEdits(ws, removalOf);
    if (c.length === 0 && beaten === undefined) continue;
    const involved = [
      ...c.flatMap((x) => [x.kept.write, ...x.others.map((o) => o.write)]),
      ...(beaten ? [beaten.removal, ...beaten.edits] : []),
    ].sort(compareWrites);
    const r: RecordReview = {
      kind: first.kind,
      id: first.rid,
      conflicts: c,
      at: involved[involved.length - 1]!.stamp,
    };
    if (beaten !== undefined) r.beaten = beaten;
    out.push(r);
  }
  return out.sort((a, b) => b.at.wall - a.at.wall || (a.id < b.id ? -1 : 1));
}

/** The member's activity cursor (`lac`): what they have reviewed up to (ms). */
export function seenUpTo(data: Readonly<TeamData>, me: string): number {
  const rec = data.entities.get(`${LAC}:${me}:${CURSOR_ID}`);
  const f = rec !== undefined && isLive(rec.state) ? visibleFields(rec.state) : {};
  return typeof f['seen'] === 'number' ? f['seen'] : 0;
}

/**
 * "N to review": records needing a look whose newest involved write is
 * after the member's cursor. A conflict or beaten edit that is mine counts
 * whatever the cursor says: my edit lost, I should see it.
 */
export function toReview(h: LibraryHistory, me: string, seen: number): number {
  return reviews(h).filter(
    (r) =>
      r.at.wall > seen ||
      r.beaten?.edits.some((e) => e.stamp.author === me) === true ||
      r.conflicts.some((c) => c.others.some((o) => o.write.stamp.author === me)),
  ).length;
}

export type ActivityAction = 'create' | 'rename' | 'move' | 'edit' | 'trash' | 'restore' | 'purge';

export interface ActivityEntry {
  opId: string;
  author: string;
  at: Stamp;
  kind: typeof LFO | typeof LIT;
  id: string;
  action: ActivityAction;
  /** Fields it wrote (without the base). */
  fields: string[];
}

/** What one write did, as one Activity line. */
export function actionOf(w: LibWrite, first: boolean): ActivityAction {
  if (w.del) return 'purge';
  const r = removalOf(w);
  if (r === 'remove') return 'trash';
  if (r === 'restore') return 'restore';
  if (first) return 'create';
  const f = Object.keys(w.fields);
  if (f.length === 1 && f[0] === 'n') return 'rename';
  if (f.includes('p')) return 'move';
  return 'edit';
}

/** Activity kept on each phone (mockups: "the last 90 days"). */
export const ACTIVITY_MS = 90 * 24 * 60 * 60 * 1000;

/** The Activity feed, newest first, over the last {@link ACTIVITY_MS}. */
export function activity(h: LibraryHistory, now: number): ActivityEntry[] {
  const since = now - ACTIVITY_MS;
  const firsts = new Set<string>();
  for (const ws of h.records.values()) firsts.add(ws[0]!.id);
  const out: ActivityEntry[] = [];
  for (const w of h.writes) {
    if (w.stamp.wall < since) continue;
    out.push({
      opId: w.id,
      author: w.stamp.author,
      at: w.stamp,
      kind: w.kind,
      id: w.rid,
      action: actionOf(w, firsts.has(w.id)),
      fields: Object.keys(w.fields).sort(),
    });
  }
  return out.reverse();
}
