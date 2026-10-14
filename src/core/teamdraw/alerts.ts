import { MAX_CLOCK_LEAD_MS } from '@core/team/hlc';
import { activeMembers, type TeamState } from '@core/team/membership';
import { LARGE_TEAM } from '@core/team/notify';
import { isAdminRole } from '@core/team/roles';

/**
 * Drawing alerts (#683): a sketch must not spam the team.
 *
 * - One in-app snackbar per author per **drawing session** (a session ends
 *   after a gap of more than 5 min between that author's strokes), on the
 *   first live stroke or finished shape.
 * - One system notification per author per session, only for a finished
 *   shape whose life is at least 1 min, following the team-message rules
 *   (`notify.ts`): an alert when it comes from an admin or a lead of one of
 *   my groups, a badge in a team of up to 30, nothing in a larger team.
 * - Never for my own drawing, never when I'm not active, and never for a
 *   shape that has already expired when it reaches me (it does not even
 *   extend the session), nor for one stamped further ahead than the clock's
 *   tolerated lead (it is not shown either, `./view`). `now` is the
 *   replica's HLC (`drawClock`).
 */
export const DRAW_SESSION_GAP_MS = 5 * 60_000;
export const NOTIFY_MIN_LIFE_MS = 60_000;

export interface DrawAlert {
  author: string;
  /** Show "<name> is drawing on the map · SHOW". */
  snackbar: boolean;
  /** A system notification, and how loud. */
  notify: 'badge' | 'alert' | null;
}

/** What arrived: a live stroke, or a finished shape with its life. */
export type DrawEvent =
  | { kind: 'pen'; author: string }
  | { kind: 'shape'; author: string; created: number; expires: number | null };

/** How a teammate's drawing notifies me, by the team-message rules. */
export function drawNotifyLevel(
  state: TeamState,
  author: string,
  me: string,
): 'badge' | 'alert' | null {
  const sender = state.members.get(author);
  const self = state.members.get(me);
  if (sender === undefined || self === undefined) return null;
  if (isAdminRole(sender.role)) return 'alert';
  const myLead = sender.groups.some(
    (l) => l.lead === true && self.groups.some((mine) => mine.g === l.g),
  );
  if (myLead) return 'alert';
  return activeMembers(state).length <= LARGE_TEAM ? 'badge' : null;
}

interface Session {
  last: number;
  snack: boolean;
  notified: boolean;
}

/** Per-author drawing sessions on this phone. Pure: the caller passes the time. */
export class DrawAlerts {
  private readonly sessions = new Map<string, Session>();

  admit(state: TeamState, e: DrawEvent, me: string, now: number): DrawAlert | null {
    if (e.author === me || state.members.get(me)?.status !== 'active') return null;
    if (state.members.get(e.author)?.status !== 'active') return null;
    if (e.kind === 'shape') {
      if (e.expires !== null && e.expires <= now) return null;
      if (e.created > now + MAX_CLOCK_LEAD_MS) return null;
    }
    let s = this.sessions.get(e.author);
    if (s === undefined || now - s.last > DRAW_SESSION_GAP_MS) {
      s = { last: now, snack: false, notified: false };
      this.sessions.set(e.author, s);
    }
    s.last = Math.max(s.last, now);
    const snackbar = !s.snack;
    s.snack = true;
    let notify: DrawAlert['notify'] = null;
    const longLived =
      e.kind === 'shape' && (e.expires === null || e.expires - e.created >= NOTIFY_MIN_LIFE_MS);
    if (longLived && !s.notified) {
      notify = drawNotifyLevel(state, e.author, me);
      if (notify !== null) s.notified = true;
    }
    return snackbar || notify !== null ? { author: e.author, snackbar, notify } : null;
  }
}
