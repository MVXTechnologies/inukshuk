/**
 * Team drawing on one open team (#683): the session's side of the pure core
 * in `@core/teamdraw`. The finished shape is a logged `e.set` of kind `drw`,
 * the stroke in progress an ephemeral `pen` (the sync session sends it only
 * to peers whose member advertises a current `cap.pen`), and this phone
 * renews its own `cap.pen` claim on each team open.
 *
 * Live strokes never go through the team's general change signal: they come
 * four times a second, and the screens that listen to it (the map among
 * them) must not re-render that often. The session reports them on their own
 * channel (`onDraw`), read by the drawing layer alone.
 */
import { isRecord, type Json } from '@core/team/canonical';
import { isLive } from '@core/team/crdt';
import { entityKey } from '@core/team/data';
import type { SignedOp } from '@core/team/envelope';
import type { TeamReplica } from '@core/team/replica';
import { isAdminRole, type Role } from '@core/team/roles';
import { DrawAlerts, type DrawAlert } from '@core/teamdraw/alerts';
import { advertisedCapBody, needsAdvertisedCap } from '@core/teamdraw/caps';
import {
  finishStroke,
  liveStrokes,
  stampWall,
  type LiveStroke,
  type PenBody,
  type Stroke,
} from '@core/teamdraw/pen';
import { drawClock, shapesOf, teamShapes, type DrawShape } from '@core/teamdraw/view';
import { encodePolyline } from '@core/trails/polyline';

import type { ActionError } from './teamSession';

/** What a drawing action could not do. */
export type DrawError = ActionError;

export interface DrawHost {
  readonly replica: TeamReplica;
  readonly me: string;
  now(): number;
  guardWrite(): DrawError | null;
  run<T>(fn: () => T, ephemeral?: (r: T) => SignedOp | undefined): T;
  dataVersion(): string;
}

/** A drawing alert, with the shape that raised it (for the notification's words). */
export interface SessionDrawAlert extends DrawAlert {
  shape: { sh: string; tx: string; expires: number | null } | null;
}

export class SessionDrawing {
  private readonly alerts = new DrawAlerts();
  private shapesCache: { key: string; until: number; shapes: DrawShape[] } | null = null;

  constructor(private readonly h: DrawHost) {}

  /** The clock drawings expire against: the replica's HLC, never behind the phone's. */
  clock(): number {
    return drawClock(this.h.replica.writer.cursor.hlc.wall, this.h.now());
  }

  private get role(): Role | undefined {
    return this.h.replica.state.members.get(this.h.me)?.role;
  }

  /** Members draw (guests don't, as they don't rally). */
  canDraw(): boolean {
    const role = this.role;
    return role !== undefined && role !== 'guest' && this.h.guardWrite() === null;
  }

  isAdmin(): boolean {
    const role = this.role;
    return role !== undefined && isAdminRole(role);
  }

  /**
   * Every visible drawing (oldest first, newest on top): the same array while
   * no data op arrived and none expired.
   */
  shapes(): DrawShape[] {
    const key = this.h.dataVersion();
    const now = this.clock();
    const c = this.shapesCache;
    if (c !== null && c.key === key && now < c.until) return c.shapes;
    const shapes = teamShapes(this.h.replica.data(now), now);
    const until = shapes.reduce((m, sh) => Math.min(m, sh.expires ?? Infinity), Infinity);
    this.shapesCache = { key, until, shapes };
    return shapes;
  }

  /** Teammates' strokes in progress (never mine: I see my own under my finger). */
  live(): LiveStroke[] {
    const r = this.h.replica;
    const now = this.h.now();
    const data = r.data(now);
    return liveStrokes(
      r.liveEphemeral(now),
      r.state,
      (op) => r.decode(op),
      (author, id) => data.entities.has(entityKey('drw', id, author)),
      this.clock(),
      (op) => r.ephemeralDeadline(op),
    ).filter((l) => l.author !== this.h.me);
  }

  /** Send my stroke so far (teammates drop it 30 s after the last update). */
  sendPen(body: PenBody): DrawError | null {
    if (!this.canDraw()) return this.h.guardWrite() ?? 'not-allowed';
    const op = this.h.run(
      () => this.h.replica.stroke(this.h.now(), body as unknown as Json),
      (r) => r,
    );
    return op === undefined ? 'rotation-pending' : null;
  }

  private live1(id: string, owner = this.h.me): boolean {
    const rec = this.h.replica.data(this.h.now()).entities.get(entityKey('drw', id, owner));
    return rec !== undefined && isLive(rec.state);
  }

  private set(id: string, f: Record<string, Json>, now = this.h.now()): DrawError | null {
    const op = this.h.run(() => this.h.replica.write(now, 'e.set', { k: 'drw', id, f }));
    if (op === undefined) return 'rotation-pending';
    return this.live1(id) ? null : 'not-allowed';
  }

  /** Pen-up: the finished shape, living `lifeMs` (null: never). */
  finish(stroke: Stroke, tolM: number, lifeMs: number | null): DrawError | null {
    if (!this.canDraw()) return this.h.guardWrite() ?? 'not-allowed';
    // One clock reading for both: the expiry is the op's own stamp + the life.
    const now = this.h.now();
    const wall = stampWall(this.h.replica.writer.cursor.hlc.wall, now);
    const f = finishStroke(stroke, tolM, wall, lifeMs);
    if (f === null) return 'invalid';
    return this.set(stroke.id, f, now);
  }

  /** A note on my shape ('' clears it). */
  setNote(id: string, note: string): DrawError | null {
    const blocked = this.h.guardWrite();
    if (blocked) return blocked;
    return this.set(id, { tx: note.slice(0, 40) });
  }

  /** Delete a shape (its author, or an admin). */
  remove(owner: string, id: string): DrawError | null {
    const blocked = this.h.guardWrite();
    if (blocked) return blocked;
    if (owner !== this.h.me && !this.isAdmin()) return 'not-allowed';
    const body: Record<string, Json> = { k: 'drw', id };
    if (owner !== this.h.me) body['o'] = owner;
    const op = this.h.run(() => this.h.replica.write(this.h.now(), 'e.del', body));
    return op === undefined ? 'rotation-pending' : null;
  }

  /** "Clear mine": every shape of mine goes; returns them for the snackbar's UNDO. */
  clearMine(): DrawShape[] {
    if (this.h.guardWrite() !== null) return [];
    const mine = shapesOf(this.shapes(), this.h.me);
    for (const s of mine) this.remove(s.owner, s.id);
    return mine;
  }

  /** UNDO: the same fields again, which revives each record (the expired ones stay gone). */
  restore(shapes: readonly DrawShape[]): number {
    if (this.h.guardWrite() !== null) return 0;
    let n = 0;
    const wall = stampWall(this.h.replica.writer.cursor.hlc.wall, this.h.now());
    for (const s of shapes) {
      if (s.owner !== this.h.me || (s.expires !== null && s.expires <= wall)) continue;
      const f: Record<string, Json> = {
        sh: s.sh,
        g: encodePolyline(s.pts),
        c: s.c,
        w: s.w,
        d: s.d,
        x: s.expires,
      };
      if (s.r !== undefined) f['r'] = s.r;
      if (s.ht !== undefined) f['ht'] = s.ht;
      if (s.hs !== undefined) f['hs'] = s.hs;
      if (s.tx.length > 0) f['tx'] = s.tx;
      if (this.set(s.id, f) === null) n++;
    }
    return n;
  }

  /** Admins (Manage team › Drawings): every shape goes, everyone's. */
  clearAll(): number {
    if (this.h.guardWrite() !== null || !this.isAdmin()) return 0;
    let n = 0;
    for (const s of this.shapes()) if (this.remove(s.owner, s.id) === null) n++;
    return n;
  }

  /**
   * Advertise `cap.pen` (and since 2.7.0 `lnk`, the LAN mux upgrade) when a
   * team is joined or opened: written when there is no
   * current claim or it is over a day old, so a claim lapses within a week of
   * the phone's last 2.5.2+ open (a rollback); true when written.
   */
  advertise(): boolean {
    const me = this.h.me;
    const r = this.h.replica;
    if (this.h.guardWrite() !== null || r.state.sendKeyId === undefined) return false;
    const now = this.h.now();
    if (!needsAdvertisedCap(r.data(now), me, now)) return false;
    const op = this.h.run(() => r.write(now, 'e.set', advertisedCapBody(me, now)));
    return op !== undefined;
  }

  /** Teammates' strokes and shapes just received: the alerts they earn (per author per session). */
  admit(ops: readonly SignedOp[]): SessionDrawAlert[] {
    const r = this.h.replica;
    const out: SessionDrawAlert[] = [];
    const now = this.clock();
    for (const op of ops) {
      if (op.env.au === this.h.me) continue;
      let alert: DrawAlert | null = null;
      let shape: SessionDrawAlert['shape'] = null;
      if (op.env.t === 'pen') {
        alert = this.alerts.admit(r.state, { kind: 'pen', author: op.env.au }, this.h.me, now);
      } else if (op.env.t === 'e.set') {
        const body = r.decode(op);
        const f = isRecord(body) && body['k'] === 'drw' ? body['f'] : undefined;
        if (!isRecord(f) || f['sh'] === undefined) continue;
        const x = f['x'];
        shape = {
          sh: String(f['sh']),
          tx: typeof f['tx'] === 'string' ? f['tx'] : '',
          expires: typeof x === 'number' ? x : null,
        };
        alert = this.alerts.admit(
          r.state,
          {
            kind: 'shape',
            author: op.env.au,
            created: op.stamp.wall,
            expires: typeof x === 'number' ? x : null,
          },
          this.h.me,
          now,
        );
      }
      if (alert !== null) out.push({ ...alert, shape });
    }
    return out;
  }
}

/** Whether a batch is only live strokes (no data the screens show). */
export function onlyPens(ops: readonly SignedOp[]): boolean {
  return ops.length > 0 && ops.every((op) => op.env.t === 'pen');
}

/** A drawing's description for its notification: "An arrow and a note: “Go around”". */
export function drawingSummary(sh: string, note: string): string {
  const what =
    sh === 'arrow'
      ? 'An arrow'
      : sh === 'circle'
        ? 'A circle'
        : sh === 'rect'
          ? 'A rectangle'
          : 'A line';
  return note.length > 0 ? `${what} and a note: “${note}”` : what;
}
