/**
 * Team mode for the screens (#589): a snapshot of the app's `TeamService`,
 * refreshed (at most every 250 ms) whenever the service reports a change.
 * Screens read the snapshot and call the service's actions directly
 * (`teamActions()`); nothing here holds protocol state of its own.
 */
import type { TeamAlert } from '@core/teamui/alerts';
import type { TeamPhoto } from '@core/teamui/comments';
import type { Said } from '@core/teamui/mapMarks';
import type { TeamPin } from '@core/teamui/pins';
import type { MemberStatus } from '@core/teamui/system';
import type { TeamTask } from '@core/team/tasks';
import type { TeammatePosition } from '@core/teamui/positions';
import type { TeamShares } from '@core/teamui/shares';
import type { TeamView } from '@core/teamui/view';
import { appTeamService } from '@data/team/appTeam';
import { notifyTeam } from '@data/team/teamNotifications';
import type { MeshLinkStatus } from '@data/team/meshLink';
import type { TeamRecord } from '@data/team/teamDisk';
import type { JoinState } from '@data/team/teamJoin';
import type { TeamService } from '@data/team/teamService';
import type { JoinNotice, PeerStatus, TeamSession } from '@data/team/teamSession';
import { create } from 'zustand';

export interface TeamBanner extends TeamAlert {
  teamName: string;
  authorName: string;
  at: number;
}

export interface TeamSnapshot {
  /** This binary has the mesh, the CSPRNG and the secure store. */
  available: boolean;
  loaded: boolean;
  teams: readonly TeamRecord[];
  activeId: string | null;
  record: TeamRecord | null;
  view: TeamView | null;
  unread: number;
  positions: TeammatePosition[];
  shares: TeamShares;
  /** Shared trail photos (thumbnails), all trails. */
  photos: TeamPhoto[];
  /** Pins (comments anchored to places) with their threads. */
  pins: TeamPin[];
  /** Every live task. */
  tasks: TeamTask[];
  /** `owner:id` of resolved messages (pins, notifies). */
  resolved: ReadonlySet<string>;
  /** Each member's newest quick status. */
  statuses: ReadonlyMap<string, MemberStatus>;
  /** Who commented on each shared photo, and when. */
  photoThreads: ReadonlyMap<string, readonly Said[]>;
  /** Changes whenever team data changes (screens reading the session directly). */
  dataVersion: string;
  peers: PeerStatus[];
  mesh: MeshLinkStatus | null;
  meshRunning: boolean;
  joinNotices: JoinNotice[];
  join: JoinState | null;
  /** The newest alert to show as a banner (cleared when shown long enough). */
  banner: TeamBanner | null;
}

interface TeamStore extends TeamSnapshot {
  refresh(): void;
  dismissBanner(): void;
}

/** The team list has been read from disk (declared before the store is created). */
let loadedFlag = false;

const EMPTY_SHARES: TeamShares = { waypoints: [], tracks: [] };
const NO_THREADS: ReadonlyMap<string, readonly Said[]> = new Map();
const NO_STATUSES: ReadonlyMap<string, MemberStatus> = new Map();
const NO_RESOLVED: ReadonlySet<string> = new Set();

function snapshot(service: TeamService | null): Omit<TeamSnapshot, 'banner'> {
  const s: TeamSession | null = service?.active ?? null;
  return {
    available: service !== null,
    loaded: loadedFlag,
    teams: service?.teams ?? [],
    activeId: s?.teamId ?? null,
    record: s?.record ?? null,
    view: s?.view() ?? null,
    unread: s?.unread() ?? 0,
    positions: s?.positions() ?? [],
    shares: s?.shares() ?? EMPTY_SHARES,
    photos: s?.photos() ?? [],
    pins: s?.pins() ?? [],
    tasks: s?.tasks() ?? [],
    statuses: s?.statuses() ?? NO_STATUSES,
    resolved: s?.resolved() ?? NO_RESOLVED,
    photoThreads: s?.photoThreads() ?? NO_THREADS,
    dataVersion: s?.dataVersion ?? '',
    peers: s?.peers() ?? [],
    mesh: s?.meshStatus() ?? null,
    meshRunning: s?.meshRunning ?? false,
    joinNotices: s ? [...s.joinNotices] : [],
    join: service?.join?.state() ?? null,
  };
}

export const useTeamStore = create<TeamStore>((set) => ({
  ...snapshot(null),
  available: appTeamService() !== null,
  loaded: false,
  banner: null,
  refresh: () => set(snapshot(appTeamService())),
  dismissBanner: () => set({ banner: null }),
}));

let wired: TeamService | null = null;
let unwire: (() => void) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Connect the store to the service (once, from `TeamHost`). Returns the service. */
export function wireTeamStore(): TeamService | null {
  const service = appTeamService();
  if (service === null || wired === service) return service;
  unwire?.();
  wired = service;
  const offChange = service.subscribe(() => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      useTeamStore.getState().refresh();
    }, 250);
  });
  const offAlert = service.onAlert((alert) => {
    const view = service.active?.view();
    const author = view?.members.find((m) => m.id === alert.author);
    const authorName = author?.name ?? 'A teammate';
    const teamName = view?.name ?? 'Team';
    useTeamStore.setState({ banner: { ...alert, teamName, authorName, at: Date.now() } });
    // The phone's own notification for what is addressed to me (`alert`).
    if (alert.level === 'alert') {
      void notifyTeam({
        title:
          alert.kind === 'task'
            ? `${authorName} · tasks · ${teamName}`
            : alert.kind === 'comment'
              ? `${authorName} commented · ${teamName}`
              : alert.priority === 2
                ? `Urgent · ${authorName} · ${teamName}`
                : `${authorName} · ${teamName}`,
        body: alert.text,
        url: alert.url,
      });
    }
  });
  unwire = () => {
    offChange();
    offAlert();
  };
  void service.load().then(() => {
    loadedFlag = true;
    useTeamStore.getState().refresh();
  });
  return service;
}

/** The service, for actions (null on binaries without team support). */
export function teamService(): TeamService | null {
  return appTeamService();
}
