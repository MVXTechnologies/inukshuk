import type { TeamState } from '../team/membership';
import { isAdminRole } from '../team/roles';

/**
 * R-INV-4 (security review §2.4.3): a join over the internet stays
 * provisional until someone other than the admitting phone vouches for the
 * log it was served. The threat: a member removed AFTER an invite was made
 * still knows that invite's room; it could serve the joiner a truncated log
 * in which it is still a member and "admit" it under the old key.
 *
 * It is confirmed when any of these holds:
 * - the two people compared the six-digit safety code (in person or on a call);
 * - the joiner completed a session with a second active member;
 * - its log holds an op by an admin other than the admitting one, made after
 *   the invite was created.
 *
 * While provisional the phone shares no position and makes no direct (non-
 * relay) WebRTC connection, so the admitting phone learns neither its place
 * nor its IP address.
 */
export interface ProvisionalJoin {
  /** The invite it joined with. */
  inviteId: string;
  /** The member whose phone wrote the `m.admit`. */
  admittedBy: string;
}

/** The provisional join this replica's own admission makes, if it came through an invite. */
export function provisionalJoinOf(
  state: Readonly<TeamState>,
  me: string,
): ProvisionalJoin | undefined {
  const m = state.members.get(me);
  if (m === undefined || m.via !== 'admit' || m.inviteId === undefined) return undefined;
  return { inviteId: m.inviteId, admittedBy: m.joinedBy };
}

/**
 * Whether a provisional join is confirmed, given the members this phone has
 * completed a session with (`peersSeen`). Total and pure.
 */
export function joinConfirmed(
  state: Readonly<TeamState>,
  join: ProvisionalJoin,
  peersSeen: Iterable<string>,
): boolean {
  for (const peer of peersSeen) {
    if (peer === join.admittedBy) continue;
    if (state.members.get(peer)?.status === 'active') return true;
  }
  const inv = state.invites.get(join.inviteId);
  if (inv === undefined) return false;
  const after = inv.createdAt.wall;
  const vouches = (author: string, wall: number) => {
    if (author === join.admittedBy || wall <= after) return false;
    const m = state.members.get(author);
    return m !== undefined && m.status === 'active' && isAdminRole(m.role);
  };
  for (const op of state.control) if (vouches(op.env.au, op.stamp.wall)) return true;
  for (const op of state.data) if (vouches(op.env.au, op.stamp.wall)) return true;
  return false;
}
