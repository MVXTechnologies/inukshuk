/**
 * Team signal mode (#589, owner 2026-10-07): with the Team extension's switch
 * on (Map overlays › Extensions) and a team open, taps on the map signal the
 * team: a trail spot opens the team's actions there, a long-press opens the
 * team menu, a teammate opens their popup. Off: the map behaves as usual.
 *
 * One small store says which compact team card is up (one at a time).
 */
import { useExtensionPrefs } from '@features/extensions/prefs';
import { useTeamStore } from '@state/teamStore';
import { create } from 'zustand';

import type { TeamMarkHit } from './TeamMapMarks';

export function useTeamSignalMode(): boolean {
  const { installedAt, show } = useExtensionPrefs('team');
  const active = useTeamStore((s) => s.view !== null && s.view.active);
  return installedAt !== 0 && show && active;
}

export type TeamSheet =
  | { kind: 'menu' }
  | { kind: 'status' }
  | { kind: 'sos' }
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
