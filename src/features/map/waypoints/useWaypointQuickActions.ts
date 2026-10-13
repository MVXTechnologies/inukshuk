import type { Units } from '@core/format';
import {
  WAITING_FOR_FIX,
  movedMessage,
  moveSummary,
  waypointDropMessage,
} from '@core/library/waypointActions';
import type { LatLng } from '@core/models';
import { reportError } from '@lib/errorReporting';
import { useLibraryStore } from '@state/libraryStore';
import { useMapStore } from '@state/mapStore';
import { useWaypointMoveStore } from '@state/waypointMoveStore';
import { useCallback, useEffect, useRef } from 'react';

import { useActionSnackbar, type ActionSnackbarState } from '../../common/useActionSnackbar';

interface Options {
  /** The GPS fix, or null before the first one. */
  location: LatLng | null;
  /** That fix's horizontal accuracy, metres, when known. */
  accuracyM: number | null | undefined;
  units: Units;
  /** Open the editor on a saved waypoint (the snackbar's EDIT). */
  onEdit: (id: string) => void;
  /**
   * Bring a waypoint under the map's centre before Move: follow off, close
   * cards, ease the camera there.
   */
  onBeforeMove: (at: LatLng) => void;
  /** The map's centre right now (fresh from the camera), or null if unknown. */
  getCenter: () => Promise<LatLng | null>;
}

export interface WaypointQuickActions {
  snack: ActionSnackbarState;
  /** + menu → Add waypoint (#671): saved at the fix in one tap. */
  addAtFix: () => void;
  /** The + menu row's sub-line, while there is no fix. */
  addHint: string | undefined;
  /** Card Move / long-press (#676): enter move mode on a saved waypoint. */
  startMove: (id: string) => void;
  cancelMove: () => void;
  confirmMove: () => Promise<void>;
}

/**
 * The map's quick waypoint actions: the one-tap drop with EDIT / UNDO (#671)
 * and Move with UNDO (#676). Logic lives here, not in MapScreen, which only
 * wires the returned handlers in.
 *
 * Per-tick cost: none. Nothing here subscribes to the fix stream — `location`
 * is read when the user taps — and the move bar reads the settled map centre
 * itself.
 */
export function useWaypointQuickActions({
  location,
  accuracyM,
  units,
  onEdit,
  onBeforeMove,
  getCenter,
}: Options): WaypointQuickActions {
  const snack = useActionSnackbar(8000);
  const { show } = snack;
  // Handlers read the latest options through a ref, so the returned
  // callbacks keep their identity across the map screen's renders.
  const opts = useRef({ location, accuracyM, units, onEdit, onBeforeMove, getCenter });
  useEffect(() => {
    opts.current = { location, accuracyM, units, onEdit, onBeforeMove, getCenter };
  });

  const addAtFix = useCallback(() => {
    const { location: at, accuracyM: acc, units: u } = opts.current;
    if (at === null) {
      // No delayed drop (owner decision): a pin dropped later, somewhere you
      // have since walked from, would surprise.
      show(WAITING_FOR_FIX);
      return;
    }
    const lib = useLibraryStore.getState();
    let id: string;
    try {
      id = lib.addWaypoint(at.latitude, at.longitude);
    } catch (err) {
      reportError(err, 'waypoint-drop');
      show('Could not save the waypoint. Please try again.');
      return;
    }
    const label =
      useLibraryStore.getState().waypoints.find((w) => w.id === id)?.label ?? 'Waypoint';
    show(waypointDropMessage(label, acc, u), [
      { label: 'Edit', onPress: () => opts.current.onEdit(id) },
      {
        label: 'Undo',
        onPress: () => {
          try {
            useLibraryStore.getState().removeWaypoint(id);
          } catch (err) {
            reportError(err, 'waypoint-drop-undo');
          }
        },
      },
    ]);
  }, [show]);

  const startMove = useCallback((id: string) => {
    const w = useLibraryStore.getState().waypoints.find((x) => x.id === id);
    if (!w) return;
    const from = { latitude: w.latitude, longitude: w.longitude };
    opts.current.onBeforeMove(from);
    useWaypointMoveStore.getState().start({
      id: w.id,
      label: w.label,
      from,
      ...(w.icon ? { icon: w.icon } : {}),
      ...(w.color ? { color: w.color } : {}),
      ...(w.size ? { size: w.size } : {}),
    });
  }, []);

  const cancelMove = useCallback(() => useWaypointMoveStore.getState().end(), []);

  const confirmMove = useCallback(async () => {
    const target = useWaypointMoveStore.getState().moving;
    if (target === null) return;
    let to: LatLng | null = null;
    try {
      to = await opts.current.getCenter();
    } catch {
      to = null;
    }
    to ??= useMapStore.getState().mapCenter;
    useWaypointMoveStore.getState().end();
    if (to === null) return;
    const summary = moveSummary(target.from, to, opts.current.units);
    if (summary.text === null) return; // nothing moved: nothing to say or undo
    try {
      useLibraryStore.getState().moveWaypoint(target.id, to.latitude, to.longitude);
    } catch (err) {
      reportError(err, 'waypoint-move');
      show('Could not move the waypoint. Please try again.');
      return;
    }
    const { from } = target;
    show(movedMessage(summary, opts.current.units), [
      {
        label: 'Undo',
        onPress: () => {
          try {
            useLibraryStore.getState().moveWaypoint(target.id, from.latitude, from.longitude);
          } catch (err) {
            reportError(err, 'waypoint-move-undo');
          }
        },
      },
    ]);
  }, [show]);

  return {
    snack,
    addAtFix,
    addHint: location === null ? WAITING_FOR_FIX : undefined,
    startMove,
    cancelMove,
    confirmMove,
  };
}
