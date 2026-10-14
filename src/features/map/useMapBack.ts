import { usePhotoCard } from '@features/photos/PhotoBottomCard';
import { useTeamMapSelection } from '@features/team/map/TeamMapOverlay';
import { useTeamSheet } from '@features/team/map/teamMode';
import { useEffect, useRef } from 'react';
import { BackHandler } from 'react-native';

import { useWaypointClusterSheet } from './waypoints/waypointTap';

/** One thing open on the map that Android Back closes. */
export interface BackLayer {
  open: boolean;
  close: () => void;
}

/** The first open layer (the list is topmost first), or null. */
export function topOpenLayer(layers: readonly BackLayer[]): BackLayer | null {
  return layers.find((l) => l.open) ?? null;
}

/**
 * Android Back on the map closes what is open — the point popup, a card, a
 * list, a sheet — one at a time, topmost first (`layers`), and leaves the app
 * only when nothing is (QA 2.6.0: Back with the point popup up exited the
 * app). Sheets with their own Back handling (the place search, the waypoint
 * and strip editors, a move, the drawing tools) keep it: they register while
 * they are up, after this one, so Back reaches them first.
 *
 * One listener, registered only while `active` (the map tab is focused: tab
 * screens stay mounted, and a listener on a hidden tab would eat its Back)
 * and something is open; the layers are read through a ref, so it is not
 * re-registered on every render.
 */
export function useMapBack(active: boolean, layers: readonly BackLayer[]): void {
  const ref = useRef(layers);
  useEffect(() => {
    ref.current = layers;
  });
  const anyOpen = layers.some((l) => l.open);
  useEffect(() => {
    if (!active || !anyOpen) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const top = topOpenLayer(ref.current);
      if (top === null) return false;
      top.close();
      return true;
    });
    return () => sub.remove();
  }, [active, anyOpen]);
}

/**
 * The map's store-held cards, for `useMapBack`: the team's card or menu, a
 * tapped team point, a photo's card, a cluster's list. Read here so the map
 * screen does not subscribe to them itself.
 */
export function useStoreBackLayers(): BackLayer[] {
  const teamSheet = useTeamSheet((s) => s.sheet !== null);
  const teamHit = useTeamMapSelection((s) => s.hit !== null);
  const photo = usePhotoCard((s) => s.target !== null);
  const cluster = useWaypointClusterSheet((s) => s.keys !== null);
  return [
    { open: teamSheet, close: () => useTeamSheet.getState().close() },
    { open: teamHit, close: () => useTeamMapSelection.getState().select(null) },
    { open: photo, close: () => usePhotoCard.getState().close() },
    { open: cluster, close: () => useWaypointClusterSheet.getState().close() },
  ];
}
