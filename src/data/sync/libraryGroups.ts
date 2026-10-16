/**
 * Shared folders and items as sync groups (2.7.0 #712): the group side of
 * Share live. The Library side is `libraryBridge.ts`.
 *
 * **A shared folder is its own group, apart from team mode** (owner,
 * 2026-10-16): its own members, its own invites, its own connectivity.
 *
 * - **Share**: a new library group (`gmeta { app: 'lib', root, net: 1 }`):
 *   its own relay room (internet on from the start) and its own capability
 *   claims (`lnk`, `rtc`), so nearby and internet paths work with no team.
 * - **Invite**: the group's own invite (`createInvite`, flag bit 1: a folder's
 *   invite), by QR or link, found nearby or through the invite's room.
 * - **Join**: the team join flow, for the folder (`startJoin`/`confirmJoin`),
 *   which never makes it the active team.
 * - **Nearby**: with no team on the LAN, the LAN advertises a shared folder
 *   (rotating through them while no link is up: one advert at a time).
 * - **Renewal** before the group's year is up (`renewal.ts`).
 * - **Leave** (keeps a copy: the bridge detaches first) and **stop sharing**
 *   (the owner closes the group; every phone keeps its copy).
 *
 * Shared folders sync while the app is open (owner Q3-A).
 */
import { DEFAULT_LIBRARY_ROLE } from '@core/domains/library/share';
import {
  LIBRARY_LIFETIME_MS,
  renewDue,
  snapshotBodies,
  successorMembers,
  successorOf,
  SUPERSEDED_KEEP_MS,
} from '@core/domains/library/renewal';
import { CURSOR_ID, LNX } from '@core/domains/library/kinds';
import { GMETA, GROUP_RECORD_ID, groupMeta, type GroupMeta } from '@core/group/meta';
import type { Json } from '@core/team/canonical';
import type { InviteToken } from '@core/team/invite';
import { advertisedCapBody, needsAdvertisedCap } from '@core/teamdraw/caps';
import type { InviteChoice } from '@core/teamui/invites';

import { DEFAULT_TEAM_PREFS } from '@data/team/teamDisk';
import type { JoinAttempt } from '@data/team/teamJoin';
import type { ActionError, CreatedInvite, TeamSession } from '@data/team/teamSession';

import type { GroupHost } from './groupHost';

/** What `TeamSession.writeData` returns when it did not write (else the op id). */
const ACTION_ERRORS: ReadonlySet<string> = new Set<ActionError>([
  'read-only',
  'not-allowed',
  'rotation-pending',
  'not-member',
  'invalid',
  'too-large',
  'no-change',
]);

/** With no link up, the LAN's advert moves to the next shared folder this often. */
export const ADVERT_ROTATE_MS = 60_000;

/** Where the dismissed set lives (groups left or refused: never picked up again). */
export interface DismissedStore {
  load(): Promise<string[]>;
  save(ids: readonly string[]): void;
}

export const memoryDismissed = (): DismissedStore => {
  let ids: string[] = [];
  return {
    load: async () => ids,
    save: (next) => {
      ids = [...next];
    },
  };
};

export interface ShareOptions {
  /** The folder's (or item's) name, shown before the log loads. */
  name: string;
  /** The share's root record id. */
  root: string;
  /** My name in the folder (its members see it). */
  myName: string;
}

/** Why a library group ended on this phone (the bridge then keeps a copy). */
export type Ended = {
  groupId: string;
  why: 'stopped' | 'removed' | 'refused' | 'superseded' | 'lost';
};

export class LibraryGroups {
  private dismissed = new Set<string>();
  private loaded: Promise<void> | null = null;

  constructor(
    readonly host: GroupHost,
    private readonly store: DismissedStore = memoryDismissed(),
  ) {}

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      await this.host.load();
      for (const id of await this.store.load()) this.dismissed.add(id);
    })();
    return this.loaded;
  }

  private dismiss(groupId: string): void {
    this.dismissed.add(groupId);
    this.store.save([...this.dismissed]);
  }

  private get now(): number {
    return this.host.now();
  }

  /** Every shared folder session this phone holds (joined or being picked up). */
  sessions(): TeamSession[] {
    const out: TeamSession[] = [];
    for (const r of this.host.libraries) {
      const s = this.host.open(r.teamId);
      if (s !== undefined) out.push(s);
    }
    return out;
  }

  meta(s: TeamSession): GroupMeta {
    return groupMeta(s.replica.data(this.now));
  }

  /** Start sharing: the folder's own group, its meta, my name and claims. */
  async share(options: ShareOptions): Promise<TeamSession | ActionError> {
    await this.load();
    const created = await this.host.create({
      name: options.name,
      myName: options.myName,
      lifetimeMs: LIBRARY_LIFETIME_MS,
      app: 'lib',
    });
    const s = created.session;
    s.replica.addKey(created.key);
    // Its own relay room from the start (net: 1); no parent, no team.
    const meta: Record<string, Json> = { app: 'lib', v: 1, root: options.root, net: 1 };
    const wrote = s.writeData('e.set', { k: GMETA, id: GROUP_RECORD_ID, f: meta });
    if (ACTION_ERRORS.has(wrote)) return 'invalid';
    s.setMyName(options.myName);
    this.claim(s);
    this.host.refreshPaths();
    return s;
  }

  /** The folder's own invite (QR or link), with who it makes (`member`: can edit; `guest`: can view). */
  invite(groupId: string, choice: InviteChoice): CreatedInvite | ActionError {
    const s = this.host.open(groupId);
    if (s === undefined || s.record.app !== 'lib') return 'not-member';
    return s.createInvite(choice);
  }

  /** Start joining a folder by its invite (the join owns the transport meanwhile). */
  async startJoin(token: InviteToken, myName: string): Promise<JoinAttempt> {
    if (token.app !== 'lib') throw new Error('not-a-folder');
    return this.host.startJoin(token, myName);
  }

  /**
   * The folder let this phone in: keep it as a shared folder (never the active
   * team), with its claims. `compared` as for a team (R-INV-4).
   */
  async confirmJoin(compared = true): Promise<TeamSession | ActionError> {
    const joined = await this.host.confirmJoin(compared);
    if (typeof joined === 'string') return joined;
    this.claim(joined);
    this.host.linkLayer?.groupsChanged();
    this.host.refreshPaths();
    return joined;
  }

  /** Renew this phone's `lnk`/`rtc` claims in a folder (they last 7 days). */
  private claim(s: TeamSession): void {
    const now = this.now;
    if (s.pickupParent() !== undefined || !s.view().active || s.view().readOnly) return;
    if (!needsAdvertisedCap(s.replica.data(now), s.me, now)) return;
    s.writeData('e.set', advertisedCapBody(s.me, now) as unknown as Json);
  }

  private advertAt = 0;
  private advertIndex = 0;

  /**
   * Nearby with no team: when the LAN does not run for a team, it advertises
   * a shared folder this phone holds, moving to the next one every
   * {@link ADVERT_ROTATE_MS} while no link is up (one advert at a time until
   * the native multi-tag advert, design §8.3).
   */
  private async advertise(): Promise<void> {
    const layer = this.host.linkLayer;
    if (layer === null || this.host.join !== null) return;
    // A renewed folder first: every member still holds it, while some may not
    // have picked its successor up yet (they meet there, then it moves over).
    const held = this.sessions().filter((s) => s.pickupParent() === undefined);
    const now0 = this.now;
    const meeting = (s: TeamSession) => this.renewed(s) && now0 <= s.replica.state.expiresAt;
    const folders = [
      ...held
        .filter(meeting)
        .map((s) => s.teamId)
        .sort(),
      ...held
        .filter((s) => !this.renewed(s))
        .map((s) => s.teamId)
        .sort(),
    ];
    if (folders.length === 0) return;
    const advertised = layer.advertised;
    // A team runs the LAN: folders ride its links (two phones may share both).
    if (advertised !== null && !this.host.libraries.some((r) => r.teamId === advertised)) return;
    const now = this.now;
    const linked = this.host.links().some((l) => l.state === 'open');
    if (advertised !== null && (linked || now - this.advertAt < ADVERT_ROTATE_MS)) return;
    this.advertIndex = advertised === null ? 0 : (this.advertIndex + 1) % folders.length;
    const next = folders[this.advertIndex]!;
    if (next === advertised) return;
    this.advertAt = now;
    await this.host.start(next);
  }

  /**
   * One pass over every group (run on host changes): re-open folders joined
   * as teams, renew claims and the year, follow renewals, advertise nearby,
   * notice ended folders. Returns the folders that ended here (the bridge
   * keeps their copy, then forgets them).
   */
  async scan(): Promise<Ended[]> {
    await this.load();
    const now = this.now;
    // 0. A folder joined through the team join flow folds as a team until its
    // meta says it is a library: re-open it as one.
    for (const t of this.host.teams) {
      const s = this.host.open(t.teamId);
      if (s === undefined || groupMeta(s.replica.data(now)).app !== 'lib') continue;
      s.updateRecord({ app: 'lib' });
      await this.host.reopen(t.teamId);
    }

    // 1. Claims and renewal: roll folders forward before their group's year is
    //    up, and pick up the successors other managers made.
    for (const s of this.sessions()) {
      if (s.pickupParent() !== undefined) continue;
      const next = successorOf(s.replica.data(now));
      if (next === undefined) {
        this.claim(s);
        if (renewDue(s.replica.state, s.me, now)) await this.renew(s);
        continue;
      }
      if (this.dismissed.has(next) || this.host.allRecords.some((r) => r.teamId === next)) continue;
      await this.host.adopt({
        teamId: next,
        name: s.record.name,
        myName: s.record.myName,
        joinedAt: now,
        prefs: { ...DEFAULT_TEAM_PREFS },
        lastReadAt: 0,
        app: 'lib',
        via: s.teamId,
      });
    }
    this.host.linkLayer?.groupsChanged();
    await this.advertise();

    // 2. Each folder: refused pickups, ended folders.
    const ended: Ended[] = [];
    for (const s of this.sessions()) {
      const state = s.replica.state;
      const mine = state.members.get(s.me);
      if (s.pickupParent() !== undefined) {
        // Removed before it arrived, or the old folder now names another successor: stop waiting.
        const via = s.record.via;
        const viaSession = via === undefined ? undefined : this.host.open(via);
        const gone =
          viaSession === undefined || successorOf(viaSession.replica.data(now)) !== s.teamId;
        if (mine?.status === 'removed' || state.closedAt !== undefined || gone) {
          ended.push({ groupId: s.teamId, why: 'refused' });
        }
        continue;
      }
      if (mine?.status === 'removed') {
        ended.push({ groupId: s.teamId, why: 'removed' });
        continue;
      }
      // A successor that lost to another (two managers renewed at once): its
      // creator closes it, and every phone forgets it once the winner is in
      // (its bridge record moves there first).
      if (this.lostRenewal(s)) {
        if (state.closedAt === undefined && state.members.get(s.me)?.role === 'owner')
          s.closeTeam();
        if (this.winnerOf(s.teamId) !== undefined) ended.push({ groupId: s.teamId, why: 'lost' });
        continue;
      }
      if (state.closedAt !== undefined) {
        ended.push({ groupId: s.teamId, why: 'stopped' });
        continue;
      }
      // A superseded folder: kept read-only a while past its expiry, then forgotten.
      const next = successorOf(s.replica.data(now));
      const nextSession = next === undefined ? undefined : this.host.open(next);
      if (nextSession !== undefined && nextSession.pickupParent() === undefined) {
        if (now > state.expiresAt + SUPERSEDED_KEEP_MS)
          ended.push({ groupId: s.teamId, why: 'superseded' });
        continue;
      }
      if (s.record.name !== s.view().name && s.view().name !== '')
        s.updateRecord({ name: s.view().name });
    }
    return ended;
  }

  /**
   * Roll a folder forward (renewal, `@core/domains/library/renewal`): a
   * successor group with the same members, roles and records, then `lnx` in
   * the old group. Returns the successor, or undefined when it could not.
   */
  async renew(s: TeamSession): Promise<TeamSession | undefined> {
    const now = this.now;
    const data = s.replica.data(now);
    const meta = this.meta(s);
    if (meta.root === undefined) return undefined;
    const created = await this.host.create({
      name: s.record.name,
      myName: s.record.myName,
      lifetimeMs: LIBRARY_LIFETIME_MS,
      app: 'lib',
    });
    const n = created.session;
    n.replica.addKey(created.key);
    const gm: Record<string, Json> = { app: 'lib', v: 1, root: meta.root, prev: s.teamId, net: 1 };
    n.writeData('e.set', { k: GMETA, id: GROUP_RECORD_ID, f: gm });
    n.setMyName(s.record.myName);
    this.claim(n);
    for (const m of successorMembers(s.replica.state, s.me)) n.addMember(m);
    for (const body of snapshotBodies(data)) n.writeData('e.set', body as unknown as Json);
    const r = s.writeData('e.set', { k: LNX, id: CURSOR_ID, f: { g: n.teamId } });
    if (ACTION_ERRORS.has(r)) {
      // The old group no longer takes writes: nobody could follow this one.
      n.closeTeam();
      await this.forget(n.teamId);
      return undefined;
    }
    this.host.refreshPaths();
    return n;
  }

  /** The joined successor of a renewed folder (undefined: none yet, or still being picked up). */
  liveSuccessor(s: TeamSession): TeamSession | undefined {
    const next = successorOf(s.replica.data(this.now));
    const n = next === undefined ? undefined : this.host.open(next);
    if (n === undefined || n.pickupParent() !== undefined) return undefined;
    return this.meta(n).root === undefined ? undefined : n;
  }

  /** Whether a folder names a successor (renewed: never written or bridged again). */
  renewed(s: TeamSession): boolean {
    return successorOf(s.replica.data(this.now)) !== undefined;
  }

  /** Whether a folder is a successor that lost a renewal race (another one carries the folder). */
  lostRenewal(s: TeamSession): boolean {
    const prev = this.meta(s).prev;
    const p = prev === undefined ? undefined : this.host.open(prev);
    const winner = p === undefined ? undefined : successorOf(p.replica.data(this.now));
    return winner !== undefined && winner !== s.teamId;
  }

  /** For a successor that lost a renewal race: the joined winner. */
  winnerOf(groupId: string): TeamSession | undefined {
    const s = this.host.open(groupId);
    if (s === undefined || !this.lostRenewal(s)) return undefined;
    const p = this.host.open(this.meta(s).prev!);
    return p === undefined ? undefined : this.liveSuccessor(p);
  }

  /** Forget a folder on this phone (after the bridge kept or removed its copy). */
  async forget(groupId: string): Promise<void> {
    await this.load();
    this.dismiss(groupId);
    await this.host.remove(groupId);
  }

  /** Leave a folder: the others see it in Activity; its group goes from this phone. */
  async leave(groupId: string): Promise<void> {
    this.host.open(groupId)?.announceLeave();
    await this.forget(groupId);
  }

  /** The owner ends the share: the group closes; every phone keeps its copy. */
  async stop(groupId: string): Promise<ActionError | null> {
    const s = this.host.open(groupId);
    if (s === undefined) return 'not-member';
    const err = s.closeTeam();
    if (err !== null) return err;
    await this.forget(groupId);
    return null;
  }

  /** The role an invite makes by default (owner #712 Q1: people can edit). */
  static readonly DEFAULT_ROLE = DEFAULT_LIBRARY_ROLE;
}
