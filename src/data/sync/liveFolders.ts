/**
 * Share live as the screens see it (2.7.0 #712, G10 mockups): one summary
 * per shared folder (header line, faces, people, review count, row notes),
 * the joining folders, and the actions of the folder's own sheet, Activity,
 * People and Recently deleted. Built on the bridge (Library side) and the
 * library groups (group side); the words come from `@core/domains/library/liveView`.
 */
import type { LFO, LIT } from '@core/domains/library/kinds';
import {
  actionOf,
  buildHistory,
  historyOps,
  recordBeaten,
  recordConflicts,
  recordMerges,
  seenUpTo,
  toReview,
  type ActivityAction,
  type LibraryHistory,
  type LibWrite,
} from '@core/domains/library/history';
import {
  activityFeed,
  peopleRows,
  peopleSummary,
  rowNote,
  syncLine,
  type ActivityFeed,
  type PersonRow,
  type SyncTone,
} from '@core/domains/library/liveView';
import { MassDeleteDetector, type MassDeleteAlert } from '@core/domains/library/massDelete';
import { libraryView, type LibraryView } from '@core/domains/library/tree';
import { trashList, trashedBy, type TrashEntry } from '@core/domains/library/trash';
import {
  restore,
  restoreAll,
  restoreWithEdits,
  setCursor,
  useVersion as versionBody,
  type SetBody,
} from '@core/domains/library/writes';
import { groupMeta } from '@core/group/meta';
import type { Json } from '@core/team/canonical';
import { isAdminRole, type Role } from '@core/team/roles';

import type { ActionError, TeamSession } from '@data/team/teamSession';

import type { LibraryBridge } from './libraryBridge';
import type { LibraryGroups } from './libraryGroups';
import type { LocalKind } from '@core/domains/library/liveFields';

type RecordKind = typeof LFO | typeof LIT;

export interface RowNote {
  text: string;
  conflict: boolean;
  /** "Not sent yet": the row's latest change is mine and no other phone holds it. */
  pending?: boolean;
}

export interface Face {
  id: string;
  initials: string;
  color: string;
}

/** One shared folder (or item) as the Library shows it. */
export interface LiveFolder {
  groupId: string;
  name: string;
  /** The Library folder or item it is (absent while joining). */
  local?: { kind: LocalKind; id: string };
  joining: boolean;
  line: { text: string; tone: SyncTone };
  /** Up to three other people (the header's faces). */
  faces: Face[];
  people: PersonRow[];
  peopleSummary: string;
  myRole: Role | undefined;
  isOwner: boolean;
  /** Owner or manager: People sub-panels, purge, the mass-delete card. */
  canManage: boolean;
  /** "Live with Chic-Chocs crew · yours" / "· from Julie". */
  subtitle: string;
  /** Who shared a folder this phone is joining. */
  sharedBy?: string;
  toReview: number;
  changesToday: number;
  trashCount: number;
  /** Notes for rows inside it, by `kind:localId` (`pending`: a change of mine no phone has yet). */
  notes: ReadonlyMap<string, RowNote>;
  massDelete: MassDeleteAlert[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

const UNSENT: Record<ActivityAction, string> = {
  create: 'added',
  rename: 'renamed',
  move: 'moved',
  edit: 'edited',
  trash: 'deleted',
  restore: 'restored',
  purge: 'deleted',
};

const ERRORS: ReadonlySet<string> = new Set<ActionError>([
  'read-only',
  'not-allowed',
  'rotation-pending',
  'not-member',
  'invalid',
  'too-large',
  'no-change',
]);

export class LiveFolders {
  private readonly lastSync = new Map<string, number>();
  private readonly delivered = new Map<string, number>();
  private readonly detectors = new Map<string, { d: MassDeleteDetector; seen: Set<string> }>();

  constructor(
    private readonly bridge: LibraryBridge,
    private readonly groups: LibraryGroups,
    private readonly now: () => number = Date.now,
  ) {}

  session(groupId: string): TeamSession | undefined {
    return this.groups.sessions().find((s) => s.teamId === groupId);
  }

  private nameOf(s: TeamSession): (id: string) => string {
    const own = new Map(s.view().members.map((m) => [m.id, m]));
    const parent = this.groups.meta(s).parent;
    const team = parent === undefined ? undefined : this.groups.host.open(parent);
    const theirs = new Map((team?.view().members ?? []).map((m) => [m.id, m]));
    return (id) => {
      const a = own.get(id);
      if (a?.named === true) return a.name;
      const b = theirs.get(id);
      return b?.name ?? a?.name ?? 'Someone';
    };
  }

  history(s: TeamSession): LibraryHistory {
    const data = s.replica.data(this.now());
    return buildHistory(historyOps(s.replica.state, data, (op) => s.decode(op)));
  }

  view(s: TeamSession): LibraryView {
    return libraryView(s.replica.data(this.now()));
  }

  /** Every shared folder and item, joined or joining. */
  list(): LiveFolder[] {
    const out: LiveFolder[] = [];
    for (const s of this.groups.sessions()) {
      // A renewal is invisible: the old folder shows until its successor is in.
      if (s.record.via !== undefined && s.pickupParent() !== undefined) continue;
      if (this.groups.liveSuccessor(s) !== undefined || this.groups.lostRenewal(s)) continue;
      const f = this.summary(s);
      if (f !== undefined) out.push(f);
    }
    return out;
  }

  private summary(s: TeamSession): LiveFolder | undefined {
    const now = this.now();
    const joining = s.pickupParent() !== undefined;
    const record = this.bridge.recordOf(s.teamId);
    const meta = this.groups.meta(s);
    const parent = meta.parent ?? s.record.parent;
    const team = parent === undefined ? undefined : this.groups.host.open(parent);
    if (joining) {
      const from = this.sharerOf(s) ?? 'your team';
      return {
        groupId: s.teamId,
        name: s.record.name,
        joining: true,
        line: syncLine({ joining: { from }, waiting: 0, now }),
        faces: [],
        people: [],
        peopleSummary: '',
        myRole: undefined,
        isOwner: false,
        canManage: false,
        subtitle: `From ${from}`,
        sharedBy: from,
        toReview: 0,
        changesToday: 0,
        trashCount: 0,
        notes: new Map(),
        massDelete: [],
      };
    }
    const name = this.nameOf(s);
    const view = this.view(s);
    const h = this.history(s);
    const data = s.replica.data(now);
    const members = [...s.replica.state.members.values()];
    const waitingIds = this.groups.waitingMembers(s.teamId);
    const managers = members.filter(
      (m) => m.status === 'active' && isAdminRole(m.role) && m.id !== s.me,
    );
    const people = peopleRows(
      members,
      s.me,
      name,
      waitingIds,
      managers[0] ? name(managers[0].id) : undefined,
    );
    const myRole = s.myRole;
    const owner = members.find((m) => m.role === 'owner')?.id;
    const isOwner = owner === s.me;
    const rootNode =
      view.root === undefined
        ? undefined
        : (view.folders.get(view.root) ?? view.items.get(view.root));
    const teamName = team?.view().name;
    const sharer =
      owner === undefined ? undefined : owner === s.me ? 'yours' : `from ${name(owner)}`;
    const subtitle = [teamName ? `Live with ${teamName}` : 'Live', sharer]
      .filter(Boolean)
      .join(' · ');
    const faces: Face[] = s
      .view()
      .members.filter((m) => m.active && !m.isMe)
      .slice(0, 3)
      .map((m) => ({ id: m.id, initials: m.initials, color: m.color }));
    // Sync line: a session open now, else the last one this launch.
    const peers = this.groups.host.linkLayer?.peers(s.teamId) ?? [];
    const open = peers.filter((p) => p.session.phase === 'open');
    if (open.length > 0) this.lastSync.set(s.teamId, now);
    const mySeq = s.replica.writer.cursor.seq;
    const seen = open
      .map((p) => p.session.peerSeq(s.me))
      .filter((x): x is number => x !== undefined);
    const known = this.delivered.get(s.teamId) ?? mySeq;
    const delivered = Math.max(known, ...seen);
    this.delivered.set(s.teamId, delivered);
    // My ops past what any peer's vector holds: their records are "not sent yet".
    const unsent = new Set(
      mySeq > delivered ? s.replica.opsInRange(s.me, delivered + 1, mySeq).map((op) => op.id) : [],
    );
    const pending = new Map<string, LibWrite>();
    for (const w of h.writes) if (unsent.has(w.id)) pending.set(`${w.kind}:${w.rid}`, w);
    const notes = new Map<string, RowNote>();
    for (const l of record?.links ?? []) {
      const mine = pending.get(`${l.kind}:${l.rid}`);
      const writes = h.records.get(`${l.kind}:${l.rid}`) ?? [];
      const n: RowNote | undefined =
        mine !== undefined
          ? {
              text: `Not sent yet · ${UNSENT[actionOf(mine, writes[0]?.id === mine.id)]} by you`,
              conflict: false,
              pending: true,
            }
          : rowNote(h, l.kind, l.rid, s.me, name, now);
      if (n !== undefined) notes.set(`${l.localKind}:${l.local}`, n);
    }
    const lastSyncAt = this.lastSync.get(s.teamId);
    return {
      groupId: s.teamId,
      name: rootNode?.name ?? s.record.name,
      ...(record?.rootLocal !== undefined ? { local: record.rootLocal } : {}),
      joining: false,
      line: syncLine({
        waiting: Math.max(0, mySeq - delivered),
        ...(lastSyncAt !== undefined ? { lastSyncAt } : {}),
        now,
      }),
      faces,
      people,
      peopleSummary: peopleSummary(people),
      myRole,
      isOwner,
      canManage: myRole !== undefined && isAdminRole(myRole),
      subtitle,
      toReview: toReview(h, s.me, seenUpTo(data, s.me)),
      changesToday: h.writes.filter((w) => now - w.stamp.wall < DAY_MS).length,
      trashCount: trashList(view, now).length,
      notes,
      massDelete:
        myRole !== undefined && isAdminRole(myRole) ? this.massDelete(s, h, view, now) : [],
    };
  }

  /** Who shared a folder being picked up (the oldest `gref`'s writer, by the team's names). */
  private sharerOf(s: TeamSession): string | undefined {
    const parent = s.record.parent;
    const team = parent === undefined ? undefined : this.groups.host.open(parent);
    if (team === undefined) return undefined;
    for (const rec of team.replica.data(this.now()).entities.values()) {
      if (rec.kind === 'gref' && rec.id === s.teamId && rec.owner !== undefined) {
        return team.view().members.find((m) => m.id === rec.owner)?.name;
      }
    }
    return undefined;
  }

  /** Deletes noted as they arrive (only recent ones: a relaunch never raises an old burst). */
  private massDelete(
    s: TeamSession,
    h: LibraryHistory,
    view: LibraryView,
    now: number,
  ): MassDeleteAlert[] {
    let e = this.detectors.get(s.teamId);
    if (e === undefined) {
      e = { d: new MassDeleteDetector(), seen: new Set() };
      this.detectors.set(s.teamId, e);
    }
    for (const w of h.writes) {
      if (e.seen.has(w.id)) continue;
      e.seen.add(w.id);
      if (w.stamp.author === s.me || now - w.stamp.wall > 10 * 60 * 1000) continue;
      const removes = w.del === true || w.fields['rm'] === 1;
      if (!removes) continue;
      const node = w.kind === 'lfo' ? view.folders.get(w.rid) : view.items.get(w.rid);
      const records =
        node === undefined
          ? [`${w.kind}:${w.rid}`]
          : trashedBy(view, node).map((n) => `${n.kind}:${n.id}`);
      e.d.note({ opId: w.id, author: w.stamp.author, at: now, records });
    }
    return e.d.alerts();
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  private write(groupId: string, body: SetBody | readonly SetBody[]): ActionError | null {
    const s = this.session(groupId);
    if (s === undefined) return 'not-member';
    for (const b of Array.isArray(body) ? body : [body]) {
      const r = s.writeData('e.set', b as unknown as Json);
      if (ERRORS.has(r)) return r as ActionError;
    }
    this.bridge.schedule();
    return null;
  }

  activity(groupId: string, author?: string): ActivityFeed | undefined {
    const s = this.session(groupId);
    if (s === undefined) return undefined;
    return activityFeed(this.history(s), this.view(s), s.me, this.nameOf(s), this.now(), author);
  }

  /** Activity was looked at: "to review" counts from now on. */
  markSeen(groupId: string): void {
    const s = this.session(groupId);
    if (s === undefined) return;
    s.writeData('e.set', setCursor(this.now()) as unknown as Json);
  }

  /** A record's open conflicts with names, and what merged silently. */
  conflict(groupId: string, kind: RecordKind, id: string) {
    const s = this.session(groupId);
    if (s === undefined) return undefined;
    const h = this.history(s);
    const name = this.nameOf(s);
    const who = (a: string) => (a === s.me ? 'You' : name(a));
    const node = kind === 'lfo' ? this.view(s).folders.get(id) : this.view(s).items.get(id);
    return {
      name: node?.name ?? '',
      type: node?.fields['t'],
      conflicts: recordConflicts(h, kind, id).map((c) => ({
        field: c.field,
        kept: {
          value: c.kept.value,
          who: who(c.kept.write.stamp.author),
          at: c.kept.write.stamp.wall,
        },
        others: c.others.map((o) => ({
          value: o.value,
          who: who(o.write.stamp.author),
          at: o.write.stamp.wall,
        })),
      })),
      merges: recordMerges(h, kind, id).map((m) => ({
        who: who(m.write.stamp.author),
        fields: m.fields,
      })),
    };
  }

  /** "Use this": the other version, written again for everyone. */
  keepVersion(
    groupId: string,
    kind: RecordKind,
    id: string,
    field: string,
    value: Json,
  ): ActionError | null {
    const s = this.session(groupId);
    if (s === undefined) return 'not-member';
    return this.write(groupId, versionBody(this.history(s), s.me, kind, id, field, value));
  }

  /** Restore from the trash; after a delete that beat edits, with those edits. */
  restore(groupId: string, kind: RecordKind, id: string): ActionError | null {
    const s = this.session(groupId);
    if (s === undefined) return 'not-member';
    const h = this.history(s);
    const beaten = recordBeaten(h, kind, id);
    return this.write(
      groupId,
      beaten !== undefined
        ? restoreWithEdits(h, s.me, kind, id, beaten.edits)
        : restore(h, s.me, kind, id),
    );
  }

  /** A manager's "Restore all" after a mass delete. */
  restoreAll(groupId: string, alert: MassDeleteAlert): ActionError | null {
    const s = this.session(groupId);
    if (s === undefined) return 'not-member';
    const records = alert.records.map((r) => {
      const [kind, id] = r.split(':') as [RecordKind, string];
      return { kind, id };
    });
    const err = this.write(groupId, restoreAll(this.history(s), s.me, records));
    if (err === null) this.detectors.get(groupId)?.d.dismiss(alert.author);
    return err;
  }

  trash(groupId: string): (TrashEntry & { by: string })[] {
    const s = this.session(groupId);
    if (s === undefined) return [];
    const name = this.nameOf(s);
    return trashList(this.view(s), this.now()).map((e) => ({
      ...e,
      by: e.since.author === s.me ? 'you' : name(e.since.author),
    }));
  }

  setRole(groupId: string, member: string, role: Role): ActionError | null {
    const s = this.session(groupId);
    return s === undefined ? 'not-member' : s.setRole(member, role);
  }

  /** Remove someone from the folder (a new key; the team will not add them back). */
  remove(groupId: string, member: string): ActionError | null {
    const s = this.session(groupId);
    if (s === undefined) return 'not-member';
    const err = s.removeMember(member);
    if (err === null) this.detectors.get(groupId)?.d.dismiss(member);
    return err;
  }

  /** Whether this folder's meta says it follows a team. */
  follows(groupId: string): boolean {
    const s = this.session(groupId);
    return s !== undefined && groupMeta(s.replica.data(this.now())).follow;
  }
}
