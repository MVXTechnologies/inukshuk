/**
 * The library bridge (2.7.0 #712, design §5.3): the two-way link between each
 * shared folder's sync group and this phone's Library. The only place that
 * changes the Library on behalf of a group; the library domain stays pure.
 *
 * - A local edit inside a shared folder (a rename, a new waypoint, a delete,
 *   an item moved out) becomes a library op, with the base of what this
 *   phone had folded (`@core/domains/library/writes`).
 * - An incoming op lands in the Library through `applySync` (origin "sync"):
 *   the bridge's base moves with it, so it never echoes back.
 * - "Leave, keep a copy" detaches: the items stay as a normal folder, and
 *   the group goes from this phone.
 *
 * Each run is the pure three-way reconcile (`@core/domains/library/bridge`)
 * per group; runs are serialized and coalesced (Library or group changes
 * schedule one), and a run over its own result does nothing.
 */
import {
  reconcile,
  type BridgePlan,
  type Link,
  type LocalOp,
  type LocalRecord,
  type RecordKind,
} from '@core/domains/library/bridge';
import {
  buildHistory,
  historyOps,
  toReview,
  seenUpTo,
  type LibraryHistory,
} from '@core/domains/library/history';
import { LFO, LIT } from '@core/domains/library/kinds';
import {
  areaFields,
  areaFrom,
  folderFields,
  mapFields,
  trackFields,
  trackFrom,
  waypointFields,
  waypointFrom,
  type LocalKind,
} from '@core/domains/library/liveFields';
import { libraryView } from '@core/domains/library/tree';
import { edit, newFolder, newItem, trash, type SetBody } from '@core/domains/library/writes';
import { groupMeta } from '@core/group/meta';
import { DEFAULT_AREA_COLOR } from '@core/library/areas';
import type { SyncEdit } from '@core/library/syncEdit';
import type {
  Area,
  Folder,
  LatLng,
  LngLat,
  MapDocument,
  TrackSummary,
  Waypoint,
} from '@core/models';
import type { Json } from '@core/team/canonical';
import { isShortId } from '@core/team/ids';
import type { Role } from '@core/team/roles';

import type { ActionError, TeamSession } from '@data/team/teamSession';

import type { Ended, LibraryGroups } from './libraryGroups';

/** What the bridge keeps per shared folder on this phone (`teams/<id>/library.json`). */
export interface BridgeRecord {
  v: 1;
  root: { kind: RecordKind; rid: string };
  /** The Library item the root is (absent on a joining phone until the root arrives). */
  rootLocal?: { kind: LocalKind; id: string };
  links: Link[];
  /** Live records this phone cannot hold yet (catalog maps to get, "not shared yet"). */
  waiting: string[];
}

export interface BridgeDisk {
  load(groupId: string): Promise<BridgeRecord | null>;
  save(groupId: string, record: BridgeRecord): void;
  remove(groupId: string): void;
}

export const memoryBridgeDisk = (): BridgeDisk & { records: Map<string, BridgeRecord> } => {
  const records = new Map<string, BridgeRecord>();
  return {
    records,
    load: async (id) => {
      const r = records.get(id);
      return r === undefined ? null : (JSON.parse(JSON.stringify(r)) as BridgeRecord);
    },
    save: (id, r) => {
      records.set(id, JSON.parse(JSON.stringify(r)) as BridgeRecord);
    },
    remove: (id) => {
      records.delete(id);
    },
  };
};

/** The Library as the bridge sees it (the app's is over `libraryStore`, `libraryPort.ts`). */
export interface LibrarySnapshot {
  folders: readonly Folder[];
  waypoints: readonly Waypoint[];
  areas: readonly Area[];
  tracks: readonly TrackSummary[];
  maps: readonly MapDocument[];
}

export interface LibraryPort {
  snapshot(): LibrarySnapshot;
  /** A trail's points (its GPX); undefined when unreadable. */
  trackPoints(t: TrackSummary): Promise<readonly LatLng[] | undefined>;
  /** Write a GPX for a trail that arrived; returns its summary (no folder yet). */
  writeTrack(id: string, name: string, points: readonly LngLat[]): TrackSummary;
  apply(edit: SyncEdit): void;
  newId(): string;
  subscribe(fn: () => void): () => void;
}


type ItemKind = Exclude<LocalKind, 'folder'>;

/** What the Library screen needs to mark shared items (#712 row markers). */
export interface SharedMark {
  groupId: string;
  /** The folder or item is the share's root. */
  root: boolean;
}

export class LibraryBridge {
  private running: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly unsubscribe: (() => void)[] = [];
  /** Trail fields by `id|fileUri` (reading a GPX per run would cost a parse each time). */
  private readonly trackCache = new Map<string, Record<string, Json>>();
  private readonly records = new Map<string, BridgeRecord>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly groups: LibraryGroups,
    private readonly port: LibraryPort,
    private readonly disk: BridgeDisk,
    private readonly options: { debounceMs?: number; now?: () => number } = {},
  ) {}

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Run on every Library or group change (`subscribeGroups`: the team service's subscribe). */
  start(subscribeGroups: (fn: () => void) => () => void): void {
    this.unsubscribe.push(this.port.subscribe(() => this.schedule()));
    this.unsubscribe.push(subscribeGroups(() => this.schedule()));
    this.schedule();
  }

  stop(): void {
    for (const off of this.unsubscribe.splice(0)) off();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Listen to what the screens show (marks, waiting items). */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch {
        // A screen's listener must not break the bridge.
      }
    }
  }

  schedule(): void {
    const ms = this.options.debounceMs ?? 300;
    if (ms <= 0) {
      void this.runAll();
      return;
    }
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runAll();
    }, ms);
  }

  /** One pass over every shared folder (serialized; a call during a pass runs once more after it). */
  runAll(): Promise<void> {
    if (this.running !== null) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async pass(): Promise<void> {
    const ended = await this.groups.scan();
    for (const e of ended) await this.end(e);
    for (const s of this.groups.sessions()) {
      if (s.pickupParent() !== undefined) continue;
      await this.runGroup(s);
    }
    this.emit();
  }

  private async record(groupId: string): Promise<BridgeRecord | null> {
    const cached = this.records.get(groupId);
    if (cached !== undefined) return cached;
    const r = await this.disk.load(groupId);
    if (r !== null) this.records.set(groupId, r);
    return r;
  }

  private save(groupId: string, r: BridgeRecord): void {
    this.records.set(groupId, r);
    this.disk.save(groupId, r);
  }

  // ── Sharing and leaving ─────────────────────────────────────────────────

  /** Share a Library folder live (with a team, or a new group). */
  async shareFolder(
    folderId: string,
    options: { team?: string; role?: Role } = {},
  ): Promise<TeamSession | ActionError> {
    const folder = this.port.snapshot().folders.find((f) => f.id === folderId);
    if (folder === undefined) return 'invalid';
    return this.share({ kind: 'folder', id: folderId }, LFO, folder.name, options);
  }

  /** Share one trail, waypoint, area or map live. */
  async shareItem(
    kind: ItemKind,
    id: string,
    options: { team?: string; role?: Role } = {},
  ): Promise<TeamSession | ActionError> {
    const item = itemOf(this.port.snapshot(), kind, id);
    if (item === undefined) return 'invalid';
    return this.share({ kind, id }, LIT, nameOf(kind, item), options);
  }

  private async share(
    rootLocal: { kind: LocalKind; id: string },
    kind: RecordKind,
    name: string,
    options: { team?: string; role?: Role },
  ): Promise<TeamSession | ActionError> {
    if (this.markOf(rootLocal.kind, rootLocal.id) !== undefined) return 'no-change';
    const rid = isShortId(rootLocal.id) ? rootLocal.id : this.port.newId();
    const s = await this.groups.share({
      name,
      root: rid,
      ...(options.team !== undefined ? { team: options.team } : {}),
      ...(options.role !== undefined ? { role: options.role } : {}),
    });
    if (typeof s === 'string') return s;
    this.save(s.teamId, { v: 1, root: { kind, rid }, rootLocal, links: [], waiting: [] });
    await this.runAll();
    return s;
  }

  /**
   * Leave a shared folder: by default the items stay as a normal folder
   * (owner #712 Q4-A); `keepCopy: false` removes them from this phone.
   */
  async leave(groupId: string, keepCopy = true): Promise<void> {
    if (!keepCopy) this.removeCopy(groupId);
    this.records.delete(groupId);
    this.disk.remove(groupId);
    await this.groups.leave(groupId);
    this.emit();
  }

  /** The owner stops sharing: every phone keeps its copy. */
  async stopSharing(groupId: string): Promise<ActionError | null> {
    const err = await this.groups.stop(groupId);
    if (err !== null) return err;
    this.records.delete(groupId);
    this.disk.remove(groupId);
    this.emit();
    return null;
  }

  private async end(e: Ended): Promise<void> {
    // A folder that ended (stopped, removed) stays as a normal folder here.
    this.records.delete(e.groupId);
    this.disk.remove(e.groupId);
    await this.groups.forget(e.groupId);
  }

  private removeCopy(groupId: string): void {
    const r = this.records.get(groupId);
    if (r === undefined) return;
    const ops: LocalOp[] = r.links.map((l) => ({
      op: 'delete',
      kind: l.localKind,
      local: l.local,
    }));
    if (r.rootLocal !== undefined && !r.links.some((l) => l.local === r.rootLocal!.id))
      ops.push({ op: 'delete', kind: r.rootLocal.kind, local: r.rootLocal.id });
    this.port.apply(this.toEdit(ops, undefined, new Map()));
  }

  // ── What the screens show ───────────────────────────────────────────────

  /** The share a Library folder or item belongs to (as root or inside a shared folder). */
  markOf(kind: LocalKind, id: string): SharedMark | undefined {
    for (const [groupId, r] of this.records) {
      if (r.rootLocal?.kind === kind && r.rootLocal.id === id) return { groupId, root: true };
      if (r.links.some((l) => l.localKind === kind && l.local === id))
        return { groupId, root: false };
    }
    return undefined;
  }

  /** The bridge's record of a shared folder (its root in the Library, links, waiting records). */
  recordOf(groupId: string): BridgeRecord | undefined {
    return this.records.get(groupId);
  }

  /** Records of a shared folder this phone cannot hold yet. */
  waiting(groupId: string): readonly string[] {
    return this.records.get(groupId)?.waiting ?? [];
  }

  /** "N to review" for a shared folder (conflicts and deletes that beat an edit). */
  toReview(groupId: string): number {
    const s = this.groups.sessions().find((x) => x.teamId === groupId);
    if (s === undefined) return 0;
    const data = s.replica.data(this.now);
    return toReview(this.history(s), s.me, seenUpTo(data, s.me));
  }

  history(s: TeamSession): LibraryHistory {
    const data = s.replica.data(this.now);
    return buildHistory(historyOps(s.replica.state, data, (op) => s.decode(op)));
  }

  // ── One group ───────────────────────────────────────────────────────────

  private async runGroup(s: TeamSession): Promise<void> {
    const data = s.replica.data(this.now);
    const meta = groupMeta(data);
    if (meta.app !== 'lib' || meta.root === undefined) return;
    const view = libraryView(data);
    let r = await this.record(s.teamId);
    if (r === null) {
      // A folder this phone joined: its root comes from the group.
      const kind: RecordKind = view.items.has(meta.root) ? LIT : LFO;
      r = { v: 1, root: { kind, rid: meta.root }, links: [], waiting: [] };
    }
    const snap = this.port.snapshot();
    const rootLocal =
      r.rootLocal ??
      (() => {
        const l = r.links.find((x) => x.rid === r.root.rid);
        return l === undefined ? undefined : { kind: l.localKind, id: l.local };
      })();
    const local = await this.scope(snap, rootLocal);
    if (rootLocal !== undefined && local.length === 0 && r.rootLocal !== undefined) {
      // The shared folder itself was deleted here: leave the share, nothing to keep.
      await this.leave(s.teamId, true);
      return;
    }
    const used = idsIn(snap);
    const plan = reconcile({
      root: r.root,
      ...(rootLocal !== undefined ? { rootLocal } : {}),
      local,
      view,
      links: r.links,
      newLocalId: (rid) => (isShortId(rid) && !used.has(rid) ? rid : this.port.newId()),
      newRecordId: (l) => (isShortId(l.id) && !view.items.has(l.id) ? l.id : this.port.newId()),
    });
    this.write(s, r, plan);
    const nextRootLocal =
      rootLocal ??
      (() => {
        const l = plan.links.find((x) => x.rid === r.root.rid);
        return l === undefined ? undefined : { kind: l.localKind, id: l.local };
      })();
    const created = new Map<string, TrackSummary>();
    for (const op of plan.local) {
      if (op.op === 'create' && op.kind === 'track') {
        const t = trackFrom(op.fields);
        if (t !== undefined)
          created.set(op.local, this.port.writeTrack(op.local, t.name, t.points));
      }
    }
    const editPlan = this.toEdit(plan.local, nextRootLocal, created);
    if (plan.local.length > 0) this.port.apply(editPlan);
    const next: BridgeRecord = {
      v: 1,
      root: r.root,
      links: plan.links,
      waiting: plan.waiting,
      ...(nextRootLocal !== undefined ? { rootLocal: nextRootLocal } : {}),
    };
    if (JSON.stringify(next) !== JSON.stringify(r) || !this.records.has(s.teamId))
      this.save(s.teamId, next);
  }

  private write(s: TeamSession, r: BridgeRecord, plan: BridgePlan): void {
    if (plan.writes.length === 0) return;
    const h = this.history(s);
    const inFolder = r.root.kind === LFO;
    for (const w of plan.writes) {
      let body: SetBody;
      if (w.op === 'new') {
        const n = typeof w.fields['n'] === 'string' ? w.fields['n'] : 'Untitled';
        const parent = inFolder && w.rid !== r.root.rid ? r.root.rid : undefined;
        if (w.kind === LFO) body = newFolder(w.rid, n, parent, w.fields);
        else {
          const t = w.fields['t'];
          if (t !== 'trk' && t !== 'wpt' && t !== 'map' && t !== 'area') continue;
          body = newItem(w.rid, t, n, parent, w.fields);
        }
      } else if (w.op === 'edit') body = edit(h, s.me, w.kind, w.rid, w.fields);
      else body = trash(h, s.me, w.kind, w.rid);
      // A write the fold refuses (a viewer, a full folder) is dropped here; the
      // next run plans it again only if the Library still differs.
      s.writeData('e.set', body as unknown as Json);
    }
  }

  /** The Library's items in a share's scope, as record fields. */
  private async scope(
    snap: LibrarySnapshot,
    rootLocal: { kind: LocalKind; id: string } | undefined,
  ): Promise<LocalRecord[]> {
    if (rootLocal === undefined) return [];
    const out: LocalRecord[] = [];
    if (rootLocal.kind === 'folder') {
      const f = snap.folders.find((x) => x.id === rootLocal.id);
      if (f === undefined) return [];
      out.push({ kind: 'folder', id: f.id, fields: folderFields(f) });
      for (const w of snap.waypoints)
        if (w.folderId === f.id)
          out.push({ kind: 'waypoint', id: w.id, fields: waypointFields(w) });
      for (const a of snap.areas)
        if (a.folderId === f.id) out.push({ kind: 'area', id: a.id, fields: areaFields(a) });
      for (const m of snap.maps)
        if (m.folderId === f.id) out.push({ kind: 'map', id: m.id, fields: mapFields(m) });
      for (const t of snap.tracks)
        if (t.folderId === f.id)
          out.push({ kind: 'track', id: t.id, fields: await this.trackOf(t) });
      return out;
    }
    const item = itemOf(snap, rootLocal.kind as ItemKind, rootLocal.id);
    if (item === undefined) return [];
    const fields =
      rootLocal.kind === 'track'
        ? await this.trackOf(item as TrackSummary)
        : rootLocal.kind === 'waypoint'
          ? waypointFields(item as Waypoint)
          : rootLocal.kind === 'area'
            ? areaFields(item as Area)
            : mapFields(item as MapDocument);
    return [{ kind: rootLocal.kind, id: rootLocal.id, fields }];
  }

  private async trackOf(t: TrackSummary): Promise<Record<string, Json>> {
    const key = `${t.id}|${t.fileUri}`;
    let f = this.trackCache.get(key);
    if (f === undefined) {
      const points = (await this.port.trackPoints(t)) ?? [];
      f = trackFields({ name: t.name, points });
      this.trackCache.set(key, f);
    }
    // The name lives in the index (a rename never rewrites the GPX).
    return { ...f, n: trackFields({ name: t.name, points: [] })['n']! };
  }

  /** Local ops as one Library edit (whole items, local-only fields kept). */
  private toEdit(
    ops: readonly LocalOp[],
    rootLocal: { kind: LocalKind; id: string } | undefined,
    created: ReadonlyMap<string, TrackSummary>,
  ): SyncEdit {
    const snap = this.port.snapshot();
    const folderId = rootLocal?.kind === 'folder' ? rootLocal.id : undefined;
    const now = this.now;
    const put = {
      folders: [] as Folder[],
      waypoints: [] as Waypoint[],
      areas: [] as Area[],
      tracks: [] as TrackSummary[],
      maps: [] as MapDocument[],
    };
    const remove = {
      folders: [] as string[],
      waypoints: [] as string[],
      areas: [] as string[],
      tracks: [] as string[],
      maps: [] as string[],
    };
    const inFolder = <T extends { folderId?: string }>(x: T, isRoot: boolean): T =>
      folderId !== undefined && !isRoot ? { ...x, folderId } : x;
    for (const op of ops) {
      const isRoot = rootLocal?.kind === op.kind && rootLocal.id === op.local;
      if (op.op === 'delete') {
        remove[pluralOf(op.kind)].push(op.local);
        continue;
      }
      switch (op.kind) {
        case 'folder': {
          const old = snap.folders.find((f) => f.id === op.local);
          const name =
            typeof op.fields['n'] === 'string' ? op.fields['n'] : (old?.name ?? 'Folder');
          put.folders.push({ id: op.local, name, createdAt: old?.createdAt ?? now });
          break;
        }
        case 'waypoint': {
          const w = waypointFrom(op.fields);
          if (w === undefined) break;
          const old = snap.waypoints.find((x) => x.id === op.local);
          const next: Waypoint = {
            id: op.local,
            latitude: w.latitude,
            longitude: w.longitude,
            label: w.label,
            createdAt: old?.createdAt ?? now,
          };
          if (w.note !== undefined) next.note = w.note;
          if (w.icon !== undefined) next.icon = w.icon;
          if (w.color !== undefined) next.color = w.color;
          if (w.size !== undefined) next.size = w.size;
          if (old?.photoUri !== undefined) next.photoUri = old.photoUri;
          if (old?.folderId !== undefined) next.folderId = old.folderId;
          put.waypoints.push(old === undefined ? inFolder(next, isRoot) : next);
          break;
        }
        case 'area': {
          const old = snap.areas.find((x) => x.id === op.local);
          const a = areaFrom(op.fields, old?.color ?? DEFAULT_AREA_COLOR);
          if (a === undefined) break;
          const next: Area = {
            ...(old ?? { createdAt: now }),
            id: op.local,
            name: a.name,
            ring: [...a.ring],
            color: a.color,
          };
          if (a.note !== undefined) next.note = a.note;
          else delete next.note;
          if (old !== undefined) next.updatedAt = now;
          put.areas.push(old === undefined ? inFolder(next, isRoot) : next);
          break;
        }
        case 'track': {
          const fresh = created.get(op.local);
          if (fresh !== undefined) {
            put.tracks.push(inFolder(fresh, isRoot));
            break;
          }
          const old = snap.tracks.find((x) => x.id === op.local);
          if (old === undefined) break;
          const name = typeof op.fields['n'] === 'string' ? op.fields['n'] : old.name;
          let next: TrackSummary = { ...old, name };
          if (op.op === 'update' && op.changed.includes('g')) {
            const t = trackFrom(op.fields);
            if (t !== undefined) {
              const written = this.port.writeTrack(this.port.newId(), name, t.points);
              next = { ...next, fileUri: written.fileUri, stats: written.stats };
            }
          }
          put.tracks.push(next);
          break;
        }
        case 'map': {
          const old = snap.maps.find((x) => x.id === op.local);
          if (old === undefined) break;
          const name = typeof op.fields['n'] === 'string' ? op.fields['n'] : old.name;
          if (name !== old.name) put.maps.push({ ...old, name });
          break;
        }
      }
    }
    const edit: SyncEdit = {};
    for (const k of ['folders', 'waypoints', 'areas', 'tracks', 'maps'] as const) {
      if (put[k].length > 0 || remove[k].length > 0)
        (edit as Record<string, unknown>)[k] = { put: put[k], remove: remove[k] };
    }
    return edit;
  }
}

function pluralOf(k: LocalKind): 'folders' | 'waypoints' | 'areas' | 'tracks' | 'maps' {
  return k === 'folder'
    ? 'folders'
    : k === 'waypoint'
      ? 'waypoints'
      : k === 'area'
        ? 'areas'
        : k === 'track'
          ? 'tracks'
          : 'maps';
}

function itemOf(
  snap: LibrarySnapshot,
  kind: ItemKind,
  id: string,
): Waypoint | Area | TrackSummary | MapDocument | undefined {
  const list: readonly { id: string }[] =
    kind === 'waypoint'
      ? snap.waypoints
      : kind === 'area'
        ? snap.areas
        : kind === 'track'
          ? snap.tracks
          : snap.maps;
  return list.find((x) => x.id === id) as Waypoint | Area | TrackSummary | MapDocument | undefined;
}

function nameOf(kind: ItemKind, item: Waypoint | Area | TrackSummary | MapDocument): string {
  return kind === 'waypoint' ? (item as Waypoint).label : (item as { name: string }).name;
}

function idsIn(snap: LibrarySnapshot): Set<string> {
  const out = new Set<string>();
  for (const list of [snap.folders, snap.waypoints, snap.areas, snap.tracks, snap.maps])
    for (const x of list) out.add(x.id);
  return out;
}
