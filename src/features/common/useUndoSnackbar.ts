import { useCallback, useEffect, useRef } from 'react';

import { useTimedSnackbar } from './useTimedSnackbar';

/**
 * A snackbar with Undo (#711: "Moved 5 items to Gaspésie 2026 · Undo").
 *
 * Built on {@link useTimedSnackbar}, so the timer is ours, never Paper's
 * (whose dismiss timer never arms on Samsung One UI). An action shown here
 * may also carry a `commit`: the part that cannot be undone (deleting the
 * files of items already taken out of the Library), run once the snackbar
 * has gone without Undo: on expiry, when it is dismissed, when another
 * action replaces it, or when the screen unmounts. Undo runs `undo` instead,
 * and the commit never happens.
 */
export interface UndoAction {
  message: string;
  undo: () => void;
  commit?: () => void;
}

export interface UndoSnackbar {
  /** The message on screen, or null. */
  message: string | null;
  show: (action: UndoAction) => void;
  /** The Undo button. */
  undo: () => void;
  /** Close without undoing (commits). */
  dismiss: () => void;
}

export function useUndoSnackbar(durationMs = 6000): UndoSnackbar {
  const timed = useTimedSnackbar(durationMs);
  const pending = useRef<UndoAction | null>(null);

  const settle = useCallback(() => {
    const action = pending.current;
    pending.current = null;
    action?.commit?.();
  }, []);

  const { show: showTimed, dismiss: dismissTimed, message } = timed;

  // The message went away by itself (the timer): the action stands.
  useEffect(() => {
    if (message === null) settle();
  }, [message, settle]);

  // Leaving the screen commits whatever is pending.
  useEffect(() => settle, [settle]);

  const show = useCallback(
    (action: UndoAction) => {
      settle();
      pending.current = action;
      showTimed(action.message);
    },
    [settle, showTimed],
  );

  const undo = useCallback(() => {
    const action = pending.current;
    pending.current = null;
    action?.undo();
    dismissTimed();
  }, [dismissTimed]);

  const dismiss = useCallback(() => {
    settle();
    dismissTimed();
  }, [settle, dismissTimed]);

  return { message, show, undo, dismiss };
}
