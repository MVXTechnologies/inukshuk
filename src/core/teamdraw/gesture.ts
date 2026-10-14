import type { ScreenPt } from './screen';

/**
 * Drawing mode's touch handling (#683), pure: the overlay over the map takes
 * every touch and feeds it here; the result says what to do.
 *
 * - One finger draws: `begin`, `update` on each move (a point at least
 *   {@link STEP_DP} from the last), `end` when it lifts.
 * - A finger held still for {@link LONG_PRESS_MS} is a long-press
 *   (`long-press`, no stroke); one lifted quickly without moving is a `tap`.
 * - A second finger cancels the stroke (`cancel`) and moves the map from
 *   then on (`pinch-start`, `pinch-move`). Nothing draws again until every
 *   finger is up, so lifting one of two never starts a stray stroke.
 *
 * The caller passes the time; it arms a timer for `longPressAt()`.
 */
export const LONG_PRESS_MS = 500;
/** A finger moving less than this is still: a tap or a long-press. */
export const SLOP_DP = 8;
/** Points closer than this to the last one are not kept. */
export const STEP_DP = 1.5;
export const TAP_MS = 350;

export interface Touch {
  id: number | string;
  x: number;
  y: number;
}

export type GestureAction =
  | { type: 'begin'; at: ScreenPt }
  | { type: 'update'; pts: readonly ScreenPt[] }
  | { type: 'end'; pts: readonly ScreenPt[] }
  | { type: 'cancel' }
  | { type: 'tap'; at: ScreenPt }
  | { type: 'long-press'; at: ScreenPt }
  | { type: 'pinch-start'; a: ScreenPt; b: ScreenPt }
  | { type: 'pinch-move'; a: ScreenPt; b: ScreenPt }
  | { type: 'pinch-end' };

type State =
  | { kind: 'idle' }
  | {
      kind: 'drawing';
      id: Touch['id'];
      pts: ScreenPt[];
      /** The first and the latest point of `pts` (never empty). */
      first: ScreenPt;
      last: ScreenPt;
      at: number;
      moved: boolean;
    }
  | { kind: 'pinch'; ids: [Touch['id'], Touch['id']] }
  | { kind: 'spent' };

const pt = (t: Touch): ScreenPt => [t.x, t.y];
const far = (a: ScreenPt, b: ScreenPt, d: number) => Math.hypot(b[0] - a[0], b[1] - a[1]) >= d;

export class DrawGesture {
  private state: State = { kind: 'idle' };

  get phase(): State['kind'] {
    return this.state.kind;
  }

  /** When a long-press fires if the finger stays still, or null. */
  longPressAt(): number | null {
    const s = this.state;
    return s.kind === 'drawing' && !s.moved ? s.at + LONG_PRESS_MS : null;
  }

  /** Fingers down or moved: `touches` is every finger on the overlay now. */
  touches(touches: readonly Touch[], now: number): GestureAction[] {
    const s = this.state;
    const [a, b] = touches;
    if (a === undefined) return this.lift(now);
    if (b !== undefined) {
      if (s.kind === 'pinch') {
        const ta = touches.find((t) => t.id === s.ids[0]);
        const tb = touches.find((t) => t.id === s.ids[1]);
        if (ta !== undefined && tb !== undefined) {
          return [{ type: 'pinch-move', a: pt(ta), b: pt(tb) }];
        }
      }
      const out: GestureAction[] = s.kind === 'drawing' ? [{ type: 'cancel' }] : [];
      if (s.kind === 'pinch') out.push({ type: 'pinch-end' });
      this.state = { kind: 'pinch', ids: [a.id, b.id] };
      out.push({ type: 'pinch-start', a: pt(a), b: pt(b) });
      return out;
    }
    const t = a;
    if (s.kind === 'idle') {
      const p = pt(t);
      this.state = {
        kind: 'drawing',
        id: t.id,
        pts: [p],
        first: p,
        last: p,
        at: now,
        moved: false,
      };
      return [{ type: 'begin', at: p }];
    }
    if (s.kind === 'pinch') {
      // One of two fingers lifted: the map stops; nothing draws until all are up.
      this.state = { kind: 'spent' };
      return [{ type: 'pinch-end' }];
    }
    if (s.kind !== 'drawing' || t.id !== s.id) return [];
    const p = pt(t);
    if (!s.moved && far(s.first, p, SLOP_DP)) s.moved = true;
    if (!far(s.last, p, STEP_DP)) return [];
    s.pts.push(p);
    s.last = p;
    return [{ type: 'update', pts: s.pts }];
  }

  /** The long-press timer fired. */
  longPress(now: number): GestureAction[] {
    const s = this.state;
    if (s.kind !== 'drawing' || s.moved || now < s.at + LONG_PRESS_MS) return [];
    this.state = { kind: 'spent' };
    return [{ type: 'cancel' }, { type: 'long-press', at: s.first }];
  }

  /** Every finger is up. */
  private lift(now: number): GestureAction[] {
    const s = this.state;
    this.state = { kind: 'idle' };
    if (s.kind === 'pinch') return [{ type: 'pinch-end' }];
    if (s.kind !== 'drawing') return [];
    if (!s.moved && now - s.at <= TAP_MS) return [{ type: 'cancel' }, { type: 'tap', at: s.first }];
    return [{ type: 'end', pts: s.pts }];
  }

  /** Throw the gesture away (the mode closed, the overlay lost the touch). */
  reset(): GestureAction[] {
    const s = this.state;
    this.state = { kind: 'idle' };
    if (s.kind === 'drawing') return [{ type: 'cancel' }];
    if (s.kind === 'pinch') return [{ type: 'pinch-end' }];
    return [];
  }
}
