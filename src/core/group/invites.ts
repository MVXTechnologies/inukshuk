import { fromB64uLen, toB64u } from '../team/bytes';
import { isLive, visibleFields } from '../team/crdt';
import { KEY_BYTES, type TeamCrypto } from '../team/crypto';
import type { TeamData } from '../team/data';
import type { InviteState, TeamState } from '../team/membership';
import { compareStamp, type Stamp } from '../team/hlc';
import type { Json } from '../team/canonical';
import { inviteIdOf, type InviteToken } from '../team/invite';

import { IRDV } from './meta';
import { inviteRendezvousSecret } from './rdv';
import { recordKey } from './registry';

/**
 * Invites over the internet (2.7.0 G7, security review §2.2 and §2.4.3).
 *
 * An invite's room derives from its seed (`ir`, `rdv.ts`), which only the
 * joiner and the inviting admin hold. The admin's phone therefore writes an
 * admin-owned, encrypted `irdv` record `{s: ir}` keyed by the invite id, so
 * every member holding the epoch key can listen in that room while the
 * invite is open, and let the joiner in as on the LAN.
 *
 * R-INV-3: removing a member revokes every invite created before the
 * removal (an ex-member who saw an invite still knows its room). The remover
 * writes the `i.revoke`s ({@link invitesToRevoke}); until those arrive, a
 * phone already stops listening for an invite older than the last removal
 * it knows ({@link inviteRooms}).
 */

/** The `irdv` record body for an invite (written by its admin with `i.create`). */
export function irdvFields(c: TeamCrypto, token: Pick<InviteToken, 'teamId' | 'seed'>) {
  return {
    id: inviteIdOf(c, token),
    f: { s: toB64u(inviteRendezvousSecret(c, token.teamId, token.seed)) } as Record<string, Json>,
  };
}

/** Whether an invite still admits someone at `now` (epoch ms). */
export function inviteOpen(inv: InviteState, now: number): boolean {
  return !inv.revoked && now <= inv.expiresAt && inv.uses < inv.maxUses;
}

/** The latest removal of any member (the stamp of its `m.remove`), if any. */
export function lastRemoval(state: Readonly<TeamState>): Stamp | undefined {
  let last: Stamp | undefined;
  for (const m of state.members.values()) {
    if (m.removedAt !== undefined && (last === undefined || compareStamp(m.removedAt, last) > 0))
      last = m.removedAt;
  }
  return last;
}

/**
 * R-INV-3: the open invites an admin's removal revokes, all of them created
 * before it (the removal is being written now, after every invite this log
 * holds).
 */
export function invitesToRevoke(state: Readonly<TeamState>, now: number): string[] {
  return [...state.invites.values()].filter((i) => inviteOpen(i, now)).map((i) => i.id);
}

/** One invite room this phone listens in: the invite and its rendezvous secret. */
export interface InviteRoom {
  inviteId: string;
  ir: Uint8Array;
}

/**
 * The invite rooms a member listens in: open invites with a readable `irdv`
 * record written by the invite's own admin, none created before the last
 * removal this phone knows (R-INV-3). Total.
 */
export function inviteRooms(
  data: Readonly<TeamData>,
  state: Readonly<TeamState>,
  now: number,
): InviteRoom[] {
  const removed = lastRemoval(state);
  const out: InviteRoom[] = [];
  for (const inv of state.invites.values()) {
    if (!inviteOpen(inv, now)) continue;
    if (removed !== undefined && compareStamp(inv.createdAt, removed) < 0) continue;
    const rec = data.entities.get(recordKey(true, IRDV, inv.id, inv.by));
    if (rec === undefined || !isLive(rec.state)) continue;
    const ir = fromB64uLen(visibleFields(rec.state)['s'], KEY_BYTES);
    if (ir !== undefined) out.push({ inviteId: inv.id, ir });
  }
  return out.sort((a, b) => (a.inviteId < b.inviteId ? -1 : 1));
}
