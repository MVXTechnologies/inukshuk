/**
 * Team mode for the screens (#589): a snapshot of the app's `TeamService`,
 * refreshed (at most every 250 ms) whenever the service reports a change.
 * Screens read the snapshot and call the service's actions directly
 * (`teamActions()`); nothing here holds protocol state of its own.
 */
import { withTeam, type TeamAlert } from '@core/teamui/alerts';
import type { TeamPhoto } from '@core/teamui/comments';
import type { Said } from '@core/teamui/mapMarks';
import type { TeamRally, TeamSos } from '@core/teamui/field';
import { threadsUnread } from '@core/teamui/threads';
import type { TeamTrailView } from '@core/teamui/trails';
import type { TeamPin } from '@core/teamui/pins';
import type { MemberStatus } from '@core/teamui/system';
import type { TeamTask } from '@core/team/tasks';
import type { TeammatePosition } from '@core/teamui/positions';
import type { TeamShares } from '@core/teamui/shares';
import type { TeamView } from '@core/teamui/view';
import { formatLeft } from '@core/teamdraw/fade';
import type { DrawShape } from '@core/teamdraw/view';
import { drawingSummary } from '@data/team/teamDraw';
import { useTeamDrawStore } from './teamDrawStore';
import { appTeamService } from '@data/team/appTeam';
import { activeEntities, AlertLedger, RallyBuzzGate } from '@core/teamui/alertLedger';
import {
  buzzRally,
  dismissTeamNotification,
  notifyTeam,
  setInAppAlarm,
} from '@data/team/teamNotifications';
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
  /** Team trails with their vertices. */
  teamTrails: TeamTrailView[];
  /** Who is editing which team trail (member → owner:id). */
  editors: ReadonlyMap<string, string>;
  /** Every live SOS, open ones first. */
  soses: TeamSos[];
  /** The team's rally point. */
  rally: TeamRally | null;
  /** Team drawings (#683), oldest first; same identity while no data op arrived. */
  drawings: DrawShape[];
  /** `owner:id` of resolved messages (pins, notifies). */
  resolved: ReadonlySet<string>;
  /** Unread messages across Team chat's sub-threads (photos, pins, trails). */
  threadsUnread: number;
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

/**
 * A teammate's SOS that has just arrived and is not acknowledged yet (#708):
 * the in-app alarm banner sounds and vibrates until Acknowledge, or until
 * the SOS is resolved.
 */
export interface SosAlarm {
  /** `sos:<owner>:<id>`. */
  entity: string;
  /**
   * The team it came from: an SOS from ANY of my teams rings (owner decision
   * 2026-10-16); when it is not the team on screen, the screens offer to
   * switch to it.
   */
  teamId: string;
  owner: string;
  authorName: string;
  teamName: string;
  text: string;
  at: number;
}

interface TeamStore extends TeamSnapshot {
  sosAlarm: SosAlarm | null;
  /**
   * TeamHost wants the mesh up (a team open, foreground or recording). With
   * `meshRunning` still false, the mesh is starting: the bar says
   * "Connecting…" rather than a transient "Offline" (QA 2.6.1).
   */
  meshWanted: boolean;
  refresh(): void;
  dismissBanner(): void;
  /** Stop this phone's alarm for the current SOS (the band stays). */
  acknowledgeAlarm(): void;
}

/** One phone alert per SOS / rally point, cleared on resolve (#708). */
const ledger = new AlertLedger();
/** The in-app rally buzz, at most once a minute per raiser (#743). */
let rallyBuzz = new RallyBuzzGate();

/** Tests: forget who buzzed when. */
export function resetRallyBuzzForTests(): void {
  rallyBuzz = new RallyBuzzGate();
}

/**
 * The SOS and rally points active in every team on this phone: the team on
 * screen from the snapshot, the others from their sessions (an SOS from any
 * team rings, so any team can end its alarm).
 */
function activeEverywhere(s: TeamSnapshot): ReadonlySet<string> {
  const out = new Set(activeEntities(s.soses, s.rally));
  const service = appTeamService();
  for (const r of s.teams) {
    if (r.teamId === s.activeId) continue;
    const other = service?.host?.open(r.teamId);
    if (other === undefined) continue;
    for (const e of activeEntities(other.soses(), null)) out.add(e);
  }
  return out;
}

/** Clear what was resolved or ended: its notification, and the alarm if it was this one. */
function settleAlerts(): void {
  const s = useTeamStore.getState();
  const active = activeEverywhere(s);
  for (const gone of ledger.settle(active)) void dismissTeamNotification(gone);
  if (s.sosAlarm !== null && !active.has(s.sosAlarm.entity)) {
    setInAppAlarm(false);
    useTeamStore.setState({ sosAlarm: null });
  }
}

/** The team list has been read from disk (declared before the store is created). */
let loadedFlag = false;

const EMPTY_SHARES: TeamShares = { waypoints: [], tracks: [] };
const NO_THREADS: ReadonlyMap<string, readonly Said[]> = new Map();
const NO_STATUSES: ReadonlyMap<string, MemberStatus> = new Map();
const NO_RESOLVED: ReadonlySet<string> = new Set();
const NO_EDITORS: ReadonlyMap<string, string> = new Map();
const NO_DRAWINGS: DrawShape[] = [];

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
    threadsUnread: s ? threadsUnread(s.threads()) : 0,
    soses: s?.soses() ?? [],
    teamTrails: s?.teamTrails() ?? [],
    editors: s?.editors() ?? NO_EDITORS,
    rally: s?.rally() ?? null,
    drawings: s?.draw.shapes() ?? NO_DRAWINGS,
    photoThreads: s?.photoThreads() ?? NO_THREADS,
    dataVersion: s?.dataVersion ?? '',
    peers: s?.peers() ?? [],
    mesh: s?.meshStatus() ?? null,
    meshRunning: s?.meshRunning ?? false,
    joinNotices: s ? [...s.joinNotices] : [],
    join: service?.join?.state() ?? null,
  };
}

/**
 * Unread in Team chat, the ONE number every chat entry shows (QA 2.6.1,
 * #707: the map chip and the panel said 7, the Team screen 3): the team
 * channel's unread plus its sub-threads' (photos, pins, trails). Chat opens
 * on both tabs, and the two sets are disjoint (the channel holds only
 * `TEAM_THREAD` messages), so the sum counts each message once.
 */
export const selectChatUnread = (s: Pick<TeamSnapshot, 'unread' | 'threadsUnread'>): number =>
  s.unread + s.threadsUnread;

export const useTeamStore = create<TeamStore>((set) => ({
  ...snapshot(null),
  available: appTeamService() !== null,
  loaded: false,
  banner: null,
  sosAlarm: null,
  meshWanted: false,
  refresh: () => {
    set(snapshot(appTeamService()));
    settleAlerts();
    // A finished shape replaces its live stroke (#683).
    refreshLive();
  },
  dismissBanner: () => set({ banner: null }),
  acknowledgeAlarm: () => {
    setInAppAlarm(false);
    set({ sosAlarm: null });
  },
}));

/**
 * Show a team (an SOS from a team not on screen, owner 2026-10-16): make it
 * the active one and refresh the store at once. True when it is on screen
 * after the call; false for a team this phone doesn't have.
 */
export async function switchToTeam(teamId: string): Promise<boolean> {
  const service = appTeamService();
  if (service === null) return false;
  if (service.active?.teamId === teamId) return true;
  if (!service.teams.some((r) => r.teamId === teamId)) return false;
  await service.activate(teamId);
  useTeamStore.getState().refresh();
  return service.active?.teamId === teamId;
}

/** The ringing SOS's team on screen (its banner or notification was tapped). */
export async function showAlarmTeam(): Promise<boolean> {
  const alarm = useTeamStore.getState().sosAlarm;
  return alarm === null ? false : switchToTeam(alarm.teamId);
}

/** Teammates' live strokes into the drawing store, at most once per frame (#683). */
let liveFrame: ReturnType<typeof requestAnimationFrame> | null = null;
function refreshLive(): void {
  useTeamDrawStore.getState().setLive(appTeamService()?.active?.draw.live() ?? []);
}
function scheduleLive(): void {
  if (liveFrame !== null) return;
  liveFrame = requestAnimationFrame(() => {
    liveFrame = null;
    refreshLive();
  });
}

let wired: TeamService | null = null;
let unwire: (() => void) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Tests: run the pending debounced refresh and live-stroke frame now, so a
 * test measures from a settled store instead of sleeping past the debounce.
 */
export function settleTeamStoreForTests(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
    useTeamStore.getState().refresh();
  }
  if (liveFrame !== null) {
    cancelAnimationFrame(liveFrame);
    liveFrame = null;
    refreshLive();
  }
}

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
  const offAlert = service.onAlert((alert, teamId) => {
    // An SOS can come from a team not on screen (owner decision 2026-10-16):
    // names and "me" from the team it came from.
    const from = service.host?.open(teamId) ?? service.active;
    const view = from?.view();
    const author = view?.members.find((m) => m.id === alert.author);
    const authorName = author?.name ?? 'A teammate';
    const teamName = view?.name ?? 'Team';
    const me = from?.me ?? '';
    // An SOS or a rally point (#708): its own channel, once per entity, never mine.
    if (alert.kind === 'sos' || alert.kind === 'rally') {
      const routed = ledger.route(alert, me);
      if (routed !== null && routed.channel === 'sos' && alert.entity) {
        setInAppAlarm(true);
        useTeamStore.setState({
          sosAlarm: {
            entity: alert.entity,
            teamId,
            owner: alert.author,
            authorName,
            teamName,
            text: alert.text,
            at: Date.now(),
          },
        });
        void notifyTeam({
          title: `SOS · ${authorName}`,
          body: `${alert.text === 'SOS · needs help' ? 'Needs help' : alert.text} · ${teamName}`,
          // Opening it shows that team, whichever is on screen now.
          url: withTeam(alert.url, teamId),
          channel: 'sos',
          identifier: routed.id,
        });
        return;
      }
      if (routed !== null && routed.channel === 'rally') {
        // In the app too, as an SOS does (#743); never over a sounding SOS alarm.
        if (useTeamStore.getState().sosAlarm === null && rallyBuzz.admit(alert.author, Date.now()))
          buzzRally();
        void notifyTeam({
          title: alert.text.startsWith('Gather · ') ? alert.text : `Gather · ${authorName}`,
          body: `${authorName} calls everyone there · ${teamName}`,
          url: alert.url,
          channel: 'rally',
          identifier: routed.id,
        });
        return;
      }
      // A resolution, or a repeat: the small in-app banner only (a badge).
      if (alert.level === 'alert') return;
    }
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
  const offDraw = service.onDraw(scheduleLive);
  const offDrawAlert = service.onDrawAlert((alert) => {
    const view = service.active?.view();
    const name = view?.members.find((m) => m.id === alert.author)?.name ?? 'A teammate';
    if (alert.snackbar) useTeamDrawStore.getState().announce(alert.author, name);
    // One system notification per author per drawing session (fade ≥ 1 min).
    if (alert.notify !== null && alert.shape !== null) {
      const life =
        alert.shape.expires === null
          ? 'never fades'
          : `fades in ${formatLeft(Math.max(0, Math.round((alert.shape.expires - Date.now()) / 1000)))}`;
      void notifyTeam({
        title: `${name.split(' ')[0]} drew on the map`,
        body: `${drawingSummary(alert.shape.sh, alert.shape.tx)} · ${life}`,
        url: `/team/draw/${alert.author}`,
        quiet: alert.notify === 'badge',
      });
    }
  });
  unwire = () => {
    offChange();
    offAlert();
    offDraw();
    offDrawAlert();
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
