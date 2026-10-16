/**
 * Shared folders and items as sync groups (2.7.0 #712, design §3.4): the
 * group side of Share live. The Library side is `libraryBridge.ts`.
 *
 * - **Share** with a team: a new library group (`gmeta { app: 'lib', root,
 *   parent: team, follow: 1 }`), the team's active members added at the
 *   chosen role from the team's roster (their ids and box keys are already
 *   there: no invite, no handshake), then a `gref` in the team so their
 *   phones learn it exists.
 * - **Pick up**: a team member's phone that sees a `gref` holds the group
 *   with an empty log ("Joining…"); its links ask a teammate for it
 *   (`LinkHost` pickups) and the log arrives with its `m.add` and key.
 * - **Follow** the team: a manager's phone adds whoever the team admits and
 *   removes whoever the team removes (owner Q2-A; `followPlan`).
 * - **Leave** (keeps a copy: the bridge detaches first) and **stop sharing**
 *   (the owner closes the group; every phone keeps its copy).
 *
 * Shared folders sync while the app is open (owner Q3-A): nothing here runs
 * in the background.
 */
import {
  followPlan,
  seedPlan,
  sharedRefs,
  DEFAULT_LIBRARY_ROLE,
} from '@core/domains/library/share';
import { GREF } from '@core/domains/team/groupKinds';
import { GMETA, GROUP_RECORD_ID, groupMeta, type GroupMeta } from '@core/group/meta';
import type { Json } from '@core/team/canonical';
import { activeMembers, MAX_TEAM_LIFETIME_MS } from '@core/team/membership';
import type { Role } from '@core/team/roles';

import { DEFAULT_TEAM_PREFS, type TeamRecord } from '@data/team/teamDisk';
import type { ActionError, TeamSession } from '@data/team/teamSession';

import type { GroupHost } from './groupHost';

/** At most this many folders wait to be picked up at once (a teammate's `gref` spam stays bounded). */
export const MAX_PICKUPS = 32;

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
  /** The share's root record id and kind. */
  root: string;
  /** The team it is shared with; absent: a new group (invites by QR). */
  team?: string;
  /** Everyone added gets this role (owner #712 Q1: editors by default). */
  role?: Role;
}

/** Why a library group ended on this phone (the bridge then keeps a copy). */
export type Ended = { groupId: string; why: 'stopped' | 'removed' | 'refused' };

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

  /** Start sharing: the group, its meta, its seeded members, the team's `gref`. */
  async share(options: ShareOptions): Promise<TeamSession | ActionError> {
    await this.load();
    const team = options.team === undefined ? undefined : this.host.open(options.team);
    if (options.team !== undefined) {
      if (team === undefined) return 'not-member';
      if (!team.view().active) return 'not-member';
      if (team.view().readOnly) return 'read-only';
    }
    const myName = team?.record.myName ?? this.host.teams[0]?.myName ?? 'Me';
    const created = await this.host.create({
      name: options.name,
      myName,
      lifetimeMs: MAX_TEAM_LIFETIME_MS,
      app: 'lib',
      ...(options.team !== undefined ? { parent: options.team } : {}),
    });
    const s = created.session;
    s.replica.addKey(created.key);
    const meta: Record<string, Json> = { app: 'lib', v: 1, root: options.root };
    if (options.team !== undefined) {
      meta['parent'] = options.team;
      meta['follow'] = 1;
    }
    const wrote = s.writeData('e.set', { k: GMETA, id: GROUP_RECORD_ID, f: meta });
    if (typeof wrote !== 'string' || wrote.length === 0) return 'invalid';
    s.setMyName(myName);
    if (team !== undefined) {
      const role = options.role ?? DEFAULT_LIBRARY_ROLE;
      const picks = activeMembers(team.replica.state).map((m) => ({ id: m.id, role }));
      for (const m of seedPlan(team.replica.state, s.me, picks)) s.addMember(m);
      team.writeData('e.set', {
        k: GREF,
        id: s.teamId,
        f: { app: 'lib', name: options.name.slice(0, 80) },
      });
    }
    return s;
  }

  /**
   * One pass over every group (run on host changes): pick up folders the
   * teams announce, follow the teams' members, notice ended folders. Returns
   * the folders that ended here (the bridge keeps their copy, then forgets them).
   */
  async scan(): Promise<Ended[]> {
    await this.load();
    const now = this.now;
    // 0. A group joined by invite (a "new group" share) folds as a team until
    // its meta says it is a library: re-open it as one.
    for (const t of this.host.teams) {
      const s = this.host.open(t.teamId);
      if (s === undefined || groupMeta(s.replica.data(now)).app !== 'lib') continue;
      s.updateRecord({ app: 'lib' });
      await this.host.reopen(t.teamId);
    }

    // 1. Pick up what the teams announce.
    let pending = this.sessions().filter((s) => s.pickupParent() !== undefined).length;
    const announced = new Set<string>();
    for (const t of this.host.teams) {
      const team = this.host.open(t.teamId);
      if (team === undefined || !team.view().active) continue;
      for (const ref of sharedRefs(team.replica.data(now))) {
        announced.add(ref.group);
        if (
          this.dismissed.has(ref.group) ||
          this.host.allRecords.some((r) => r.teamId === ref.group)
        )
          continue;
        if (pending >= MAX_PICKUPS) break;
        pending++;
        const record: TeamRecord = {
          teamId: ref.group,
          name: ref.name ?? 'Shared folder',
          myName: t.myName,
          joinedAt: now,
          prefs: { ...DEFAULT_TEAM_PREFS },
          lastReadAt: 0,
          app: 'lib',
          parent: t.teamId,
        };
        await this.host.adopt(record);
      }
    }
    this.host.linkLayer?.groupsChanged();

    // 2. Each folder: refused pickups, ended folders, following its team.
    const ended: Ended[] = [];
    for (const s of this.sessions()) {
      const state = s.replica.state;
      const mine = state.members.get(s.me);
      const parent = s.pickupParent();
      if (parent !== undefined) {
        // Removed before it arrived, or the share is gone from the team: stop waiting.
        const gone = !announced.has(s.teamId) && this.host.open(parent) !== undefined;
        if (mine?.status === 'removed' || state.closedAt !== undefined || gone) {
          ended.push({ groupId: s.teamId, why: 'refused' });
        }
        continue;
      }
      if (mine?.status === 'removed') {
        ended.push({ groupId: s.teamId, why: 'removed' });
        continue;
      }
      if (state.closedAt !== undefined) {
        ended.push({ groupId: s.teamId, why: 'stopped' });
        continue;
      }
      if (s.record.name !== s.view().name && s.view().name !== '')
        s.updateRecord({ name: s.view().name });
      const meta = this.meta(s);
      if (!meta.follow || meta.parent === undefined) continue;
      const team = this.host.open(meta.parent);
      if (team === undefined) continue;
      const plan = followPlan(team.replica.state, state, meta, s.me);
      for (const m of plan.add) s.addMember(m);
      for (const id of plan.remove) s.removeMember(id);
    }
    return ended;
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

  /** The owner ends the share: the group closes, the team's `gref` goes. */
  async stop(groupId: string): Promise<ActionError | null> {
    const s = this.host.open(groupId);
    if (s === undefined) return 'not-member';
    const err = s.closeTeam();
    if (err !== null) return err;
    const parent = this.meta(s).parent;
    if (parent !== undefined) this.host.open(parent)?.writeData('e.del', { k: GREF, id: groupId });
    await this.forget(groupId);
    return null;
  }

  /** Who is waiting to be added by a manager's phone (follow): active team members not in the folder. */
  waitingMembers(groupId: string): string[] {
    const s = this.host.open(groupId);
    if (s === undefined) return [];
    const meta = this.meta(s);
    if (!meta.follow || meta.parent === undefined) return [];
    const team = this.host.open(meta.parent);
    if (team === undefined) return [];
    return activeMembers(team.replica.state)
      .map((m) => m.id)
      .filter((id) => !s.replica.state.members.has(id))
      .sort();
  }
}
