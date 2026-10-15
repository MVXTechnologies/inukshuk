/**
 * Team signal mode (#589, owner 2026-10-07): with the Team extension's switch
 * on (Map overlays › Extensions) and a team open, taps on the map signal the
 * team: a trail spot opens the team's actions there, a long-press opens the
 * team menu, a teammate opens their popup. Off: the map behaves as usual.
 *
 * One small store says which compact team card is up (one at a time).
 */
import { searchSlotMode, type SearchSlotMode } from '@core/teamui/searchSlot';
import { useExtensionPrefs } from '@features/extensions/prefs';
import { useSettingsStore } from '@state/settingsStore';
import { useTeamStore } from '@state/teamStore';
import { useEffect, useState } from 'react';
import { create } from 'zustand';

import type { TeamMarkHit } from './TeamMapMarks';

export function useTeamSignalMode(): boolean {
  const { installedAt, show } = useExtensionPrefs('team');
  const active = useTeamStore((s) => s.view !== null && s.view.active);
  return installedAt !== 0 && show && active;
}

/** The longest the map's top slot waits for team mode to be known, ms. */
export const SEARCH_SLOT_MAX_WAIT_MS = 4000;

/**
 * What the map's top slot shows (#707, `@core/teamui/searchSlot`): `search`
 * (the place search pill), `team` (team mode: the team status bar's slot),
 * or `pending` — draw nothing yet. Settles once per launch; a reopen that
 * hangs or fails falls back to `search` after {@link SEARCH_SLOT_MAX_WAIT_MS}.
 */
export function useSearchSlotMode(): SearchSlotMode {
  const settingsHydrated = useSettingsStore((s) => s.hydrated);
  const { installedAt, show } = useExtensionPrefs('team');
  const teamAvailable = useTeamStore((s) => s.available);
  const teamsLoaded = useTeamStore((s) => s.loaded);
  const teamCount = useTeamStore((s) => s.teams.length);
  const sessionOpen = useTeamStore((s) => s.view !== null);
  const memberActive = useTeamStore((s) => s.view !== null && s.view.active);
  const mode = searchSlotMode({
    settingsHydrated,
    teamEnabled: installedAt !== 0 && show,
    teamAvailable,
    teamsLoaded,
    teamCount,
    sessionOpen,
    memberActive,
  });
  const [waitedOut, setWaitedOut] = useState(false);
  const pending = mode === 'pending';
  useEffect(() => {
    if (!pending || waitedOut) return;
    const timer = setTimeout(() => setWaitedOut(true), SEARCH_SLOT_MAX_WAIT_MS);
    return () => clearTimeout(timer);
  }, [pending, waitedOut]);
  return pending && waitedOut ? 'search' : mode;
}

export type TeamSheet =
  /** The team panel, dropped from the bar (#707). */
  | { kind: 'menu' }
  | { kind: 'status' }
  | { kind: 'notify'; at: [number, number] | null }
  | {
      kind: 'spot';
      at: [number, number];
      trail: string;
      trackId?: string;
      /** A team trail (editable by all members). */
      team?: { owner: string; id: string };
    }
  | { kind: 'press'; at: [number, number] }
  /** Co-located marks a cluster can't split further. */
  | { kind: 'list'; items: TeamMarkHit[] };

export const useTeamSheet = create<{
  sheet: TeamSheet | null;
  open: (sheet: TeamSheet) => void;
  close: () => void;
}>((set) => ({
  sheet: null,
  open: (sheet) => set({ sheet }),
  close: () => set({ sheet: null }),
}));
