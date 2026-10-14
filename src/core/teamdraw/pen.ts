import { canonicalize, isRecord, type Json } from '@core/team/canonical';
import type { Decode } from '@core/team/data';
import type { SignedOp } from '@core/team/envelope';
import { expiresAt, PEN_TTL_S } from '@core/team/envelope';
import { MAX_CLOCK_LEAD_MS } from '@core/team/hlc';
import { isShortId } from '@core/team/ids';
import { admitEphemeral, type TeamState } from '@core/team/membership';
import { encodePolyline } from '@core/trails/polyline';

import { metresPerDp, simplify, type Pt } from './geo';
import {
  drawWrite,
  MAX_FREE_POINTS,
  parseGeometry,
  validStyle,
  type HeadType,
  type ShapeKind,
} from './record';

/**
 * Strokes (#683): the stroke in progress travels as the ephemeral op `pen`
 * (like `pos`: sq 0, no chain, ttl 30 s, the op log keeps the newest per
 * author), and the finished stroke as the `drw` record (`./record`).
 *
 * ```
 * pen { id: <the final drw id>, sh, g: <stroke so far>, r?, c, w, d, ht?, hs? }
 * ```
 * - each update holds the whole stroke so far (a lost one heals on the next);
 * - simplified first: Douglas–Peucker at 1.5 dp, in metres at the drawer's zoom;
 * - capped at 6 KB of envelope: past that the preview stops growing (the
 *   final `e.set` carries it all, ≤ 32 KB);
 * - sent at most every 250 ms, and only when it changed ({@link PenThrottle});
 * - pen-up sends the `drw` with the same id; receivers drop the live line then.
 */

/** Plaintext cap: with the AEAD tag, base64 and the header, the envelope stays ≤ 6 KB. */
export const MAX_PEN_BODY_BYTES = 4_096;
export const PEN_INTERVAL_MS = 250;
const PEN_TTL_MS = PEN_TTL_S * 1000;
/** Simplification tolerance on screen. */
export const SIMPLIFY_DP = 1.5;

const PEN_KEYS: readonly string[] = ['id', 'sh', 'g', 'r', 'c', 'w', 'd', 'ht', 'hs'];

export interface PenStyle {
  c: number;
  w: 1 | 2 | 3;
  d: boolean;
  /** Arrows only. */
  ht?: HeadType;
  hs?: 1 | 2 | 3;
}

/** A stroke as the drawer's phone holds it. */
export interface Stroke {
  id: string;
  sh: ShapeKind;
  /** free: the finger's path; arrow: [tail, head]; circle: [centre]; rect: 4 corners. */
  pts: readonly Pt[];
  /** Circle radius, m. */
  r?: number;
  style: PenStyle;
}

/** A type alias (not an interface) so a body is plain `Json` for `TeamReplica.stroke`. */
export type PenBody = {
  id: string;
  sh: ShapeKind;
  g: string;
  r?: number;
  c: number;
  w: 1 | 2 | 3;
  d: boolean;
  ht?: HeadType;
  hs?: 1 | 2 | 3;
};

/** The simplification tolerance in metres at the drawer's zoom and latitude. */
export function toleranceM(zoom: number, lat: number, dp = SIMPLIFY_DP): number {
  return metresPerDp(zoom, lat) * dp;
}

function styleOf(s: Stroke): Record<string, Json> {
  const out: Record<string, Json> = { sh: s.sh, c: s.style.c, w: s.style.w, d: s.style.d };
  if (s.sh === 'arrow') {
    out['ht'] = s.style.ht ?? 'fill';
    out['hs'] = s.style.hs ?? 2;
  }
  if (s.sh === 'circle' && s.r !== undefined) out['r'] = Math.round(s.r * 10) / 10;
  return out;
}

const pointsOf = (s: Stroke, tol: number): readonly Pt[] =>
  s.sh === 'free' ? simplify(s.pts, tol) : s.pts;

/**
 * The `pen` body for a stroke so far, or null when it is not sendable: past
 * the 6 KB cap (the preview stops growing) or not a shape yet.
 */
export function penBody(s: Stroke, tolM: number): PenBody | null {
  const body = { id: s.id, g: encodePolyline(pointsOf(s, tolM)), ...styleOf(s) };
  const text = canonicalize(body);
  if (text === undefined || text.length > MAX_PEN_BODY_BYTES) return null;
  return parsePenBody(body);
}

/** A received `pen` body, checked like a shape (a stroke may hold one point), or null. */
export function parsePenBody(v: unknown): PenBody | null {
  if (!isRecord(v) || !Object.keys(v).every((k) => PEN_KEYS.includes(k))) return null;
  if (!isShortId(v['id'])) return null;
  const f = v as Record<string, Json>;
  if (parseGeometry(f['sh'], f['g'], f['r'], 1) === null || !validStyle(f)) return null;
  return v as unknown as PenBody;
}

/**
 * The `drw` fields for a finished stroke: simplified at `tolM` (coarser if a
 * long stroke still holds more than 500 points), with expiry `x` = `wall` +
 * life (null = never). `wall` must be the op's own HLC wall: use
 * {@link stampWall}. Null when the stroke is not a valid shape.
 */
export function finishStroke(
  s: Stroke,
  tolM: number,
  wall: number,
  lifeMs: number | null,
  note?: string,
): Record<string, Json> | null {
  let tol = tolM > 0 ? tolM : 0.5;
  let pts = pointsOf(s, tol);
  while (pts.length > MAX_FREE_POINTS) {
    tol *= 2;
    pts = pointsOf(s, tol);
  }
  const f: Record<string, Json> = {
    ...styleOf(s),
    g: encodePolyline(pts),
    x: lifeMs === null ? null : wall + lifeMs,
  };
  if (note !== undefined && note.length > 0) f['tx'] = note;
  return drawWrite(f, wall) === 'full' ? f : null;
}

/**
 * The wall time the writer will stamp the next op with: never behind its
 * clock (which may lead the phone's by up to 5 min after a peer's op).
 */
export function stampWall(clockWall: number, now: number): number {
  return Math.max(clockWall, Math.floor(now));
}

/**
 * The send scheduler for one drawer: at most one `pen` per
 * {@link PEN_INTERVAL_MS}, only when the stroke changed. Pure: the caller
 * passes the time, offers each new body, and asks `due` when `nextAt` comes.
 */
export class PenThrottle {
  private lastAt = -Infinity;
  private lastText: string | undefined;
  private pending: PenBody | undefined;
  /** Bodies handed out to send (for tests and diagnostics). */
  sent = 0;

  constructor(private readonly intervalMs = PEN_INTERVAL_MS) {}

  /** A newer stroke: returns it if it may go now, else keeps it for {@link due}. */
  offer(body: PenBody | null, now: number): PenBody | null {
    if (body === null) return null; // past the cap: the preview stops growing
    if (canonicalize(body as unknown as Json) === this.lastText) {
      this.pending = undefined;
      return null;
    }
    this.pending = body;
    return this.due(now);
  }

  /** The kept stroke, if the interval has passed. */
  due(now: number): PenBody | null {
    const body = this.pending;
    if (body === undefined || now - this.lastAt < this.intervalMs) return null;
    this.pending = undefined;
    this.lastAt = now;
    this.lastText = canonicalize(body as unknown as Json);
    this.sent++;
    return body;
  }

  /** When the next body may go (now or past: at once). */
  readyAt(): number {
    return this.lastAt + this.intervalMs;
  }

  /** When a kept stroke may go, or null when nothing waits. */
  nextAt(): number | null {
    return this.pending === undefined ? null : this.lastAt + this.intervalMs;
  }

  /** Pen-up: forget the stroke (the next one starts fresh). */
  reset(): void {
    this.pending = undefined;
    this.lastText = undefined;
  }
}

/** A teammate's stroke in progress, ready to draw. */
export interface LiveStroke extends PenBody {
  author: string;
  pts: Pt[];
  /** HLC wall of the update. */
  at: number;
  /**
   * When it disappears if no update or final shape arrives, by this phone's
   * clock: at most {@link PEN_TTL_S} after it arrived (or after its stamp).
   */
  until: number;
}

/**
 * The live strokes to draw at `now` (the replica's clock, `drawClock`): `pen`
 * ops admitted against the current team state (active members, data-op
 * rules: guests do not draw), valid bodies, minus those whose final shape is
 * already here (`finished(author, id)`) and those stamped further ahead than
 * the clock's tolerated lead. `arrived` is the replica's arrival deadline
 * (`TeamReplica.ephemeralDeadline`): it keeps a stroke live on a phone whose
 * clock runs ahead of the drawer's. Without it, the stroke's own stamp counts.
 */
export function liveStrokes(
  ops: readonly SignedOp[],
  state: TeamState,
  decode: Decode,
  finished: (author: string, id: string) => boolean,
  now: number,
  arrived?: (op: SignedOp) => number | undefined,
): LiveStroke[] {
  const out: LiveStroke[] = [];
  for (const op of ops) {
    if (op.env.t !== 'pen' || !admitEphemeral(state, op)) continue;
    if (op.stamp.wall > now + MAX_CLOCK_LEAD_MS) continue;
    const body = parsePenBody(decode(op));
    if (body === null || finished(op.env.au, body.id)) continue;
    const pts = parseGeometry(body.sh, body.g, body.r, 1)!;
    out.push({
      ...body,
      author: op.env.au,
      pts,
      at: op.stamp.wall,
      until: Math.min(
        arrived?.(op) ?? Math.min(expiresAt(op.env)!, op.stamp.wall + PEN_TTL_MS),
        now + PEN_TTL_MS,
      ),
    });
  }
  return out;
}
