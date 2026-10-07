/**
 * Team mode for the screens (#589): a snapshot of the app's `TeamService`,
 * refreshed (at most every 250 ms) whenever the service reports a change.
 * Screens read the snapshot and call the service's actions directly
 * (`teamActions()`); nothing here holds protocol state of its own.
 */
import type { TeamAlert } from '@core/teamui/alerts';
import type { TeammatePosition } from '@core/teamui/positions';
import type { TeamShares } from '@core/teamui/shares';
import type { TeamView } from '@core/teamui/view';
import { appTeamService } from '@data/team/appTeam';
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

let wired = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Connect the store to the service (once, from `TeamHost`). Returns the service. */
export function wireTeamStore(): TeamService | null {
  const service = appTeamService();
  if (service === null || wired) return service;
  wired = true;
  service.subscribe(() => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      useTeamStore.getState().refresh();
    }, 250);
  });
  service.onAlert((alert) => {
    const view = service.active?.view();
    const author = view?.members.find((m) => m.id === alert.author);
    useTeamStore.setState({
      banner: {
        ...alert,
        teamName: view?.name ?? 'Team',
        authorName: author?.name ?? 'A teammate',
        at: Date.now(),
      },
    });
  });
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
