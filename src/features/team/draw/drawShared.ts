/**
 * Small pieces the drawing screens share (#683): my style, normalised against
 * my member colour; framing an author's shapes on the map ("SHOW").
 */
import { MEMBER_COLORS } from '@core/teamui/colors';
import { frameCamera } from '@core/teamdraw/screen';
import { normalisePrefs, type DrawPrefs } from '@core/teamdraw/style';
import { useTeamDrawStore } from '@state/teamDrawStore';
import { useTeamStore } from '@state/teamStore';
import { useMemo } from 'react';
import { Dimensions } from 'react-native';

import { useTeamMapFocus } from '../map/teamMapFocus';

/** The member hues' names, in MEMBER_COLORS order. */
export const COLOUR_NAMES = [
  'ember',
  'lake',
  'heather',
  'spruce',
  'larch',
  'fireweed',
  'moss',
  'granite',
] as const;

/** My member colour's index (0 when not known yet). */
export function useOwnColour(): number {
  const color = useTeamStore((s) => s.view?.members.find((m) => m.isMe)?.color);
  const i = color === undefined ? -1 : (MEMBER_COLORS as readonly string[]).indexOf(color);
  return i < 0 ? 0 : i;
}

/** My drawing style (stored, repaired field by field; my colour by default). */
export function useDrawPrefs(): DrawPrefs {
  const raw = useTeamDrawStore((s) => s.rawPrefs);
  const own = useOwnColour();
  return useMemo(() => normalisePrefs(raw, own), [raw, own]);
}

/**
 * Frame an author's shapes and live strokes on the main map. False when they
 * have none left (all faded): the caller says so.
 */
export function showAuthor(author: string): boolean {
  const shapes = useTeamStore.getState().drawings.filter((s) => s.owner === author);
  const live = useTeamDrawStore.getState().live.filter((l) => l.author === author);
  const parts = [
    ...shapes.map((s) => (s.r !== undefined ? { pts: s.pts, r: s.r } : { pts: s.pts })),
    ...live.map((l) => (l.r !== undefined ? { pts: l.pts, r: l.r } : { pts: l.pts })),
  ];
  const { width, height } = Dimensions.get('window');
  const cam = frameCamera(parts, width, height * 0.7);
  if (cam === null) return false;
  useTeamMapFocus.getState().focus(cam.center[0], cam.center[1], cam.zoom);
  return true;
}
