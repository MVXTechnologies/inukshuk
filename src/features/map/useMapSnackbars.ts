import { useCallback, useEffect, useMemo, useRef } from 'react';

import {
  useActionSnackbar,
  type ActionSnackbarState,
  type SnackAction,
} from '../common/useActionSnackbar';
import { useTimedSnackbar, type TimedSnackbar } from '../common/useTimedSnackbar';

/** A plain map message ("Coordinates copied"), ms. */
export const MAP_SNACK_MS = 3000;
/** The EDIT / UNDO bar (#671, #676): long enough to read and reach, ms. */
export const MAP_ACTION_SNACK_MS = 8000;

export interface MapSnackbars {
  /** Plain messages; draw with Paper's Snackbar at `duration={Infinity}`. */
  plain: TimedSnackbar;
  /** The EDIT / UNDO bar; draw with `<ActionSnackbar>`. */
  action: ActionSnackbarState;
}

/**
 * The map's two snackbars as ONE slot (2.5.1 review): they share the bottom
 * edge and the z-order, so two at once drew one over the other.
 *
 * - Showing the action bar dismisses a plain message: it is the newer one,
 *   and the one with something to do.
 * - A plain message never covers an action bar: while EDIT / UNDO is up it
 *   waits (the latest one only), and shows when the bar goes — by its timer,
 *   an action or a dismiss. So EDIT / UNDO is never hidden.
 *
 * Both keep their own JS timers (never Paper's, which sticks on One UI).
 */
export function useMapSnackbars(): MapSnackbars {
  const plain = useTimedSnackbar(MAP_SNACK_MS);
  const action = useActionSnackbar(MAP_ACTION_SNACK_MS);
  const { message: plainMessage, show: showPlainNow, dismiss: dismissPlain } = plain;
  const { show: showActionNow, dismiss: dismissAction, current: actionUp } = action;
  // Read by handlers, never during render. Set synchronously by showAction so
  // a plain message sent in the same tick already waits.
  const actionShowing = useRef(false);
  const waiting = useRef<string | null>(null);

  const showAction = useCallback(
    (message: string, actions?: readonly SnackAction[]) => {
      actionShowing.current = true;
      dismissPlain();
      showActionNow(message, actions);
    },
    [dismissPlain, showActionNow],
  );

  const showPlain = useCallback(
    (message: string) => {
      if (actionShowing.current) waiting.current = message;
      else showPlainNow(message);
    },
    [showPlainNow],
  );

  // The bar went (timer, action or dismiss): the waiting message gets its turn.
  useEffect(() => {
    if (actionUp !== null) return;
    actionShowing.current = false;
    const next = waiting.current;
    waiting.current = null;
    if (next !== null) showPlainNow(next);
  }, [actionUp, showPlainNow]);

  return useMemo(
    () => ({
      plain: { message: plainMessage, show: showPlain, dismiss: dismissPlain },
      action: { current: actionUp, show: showAction, dismiss: dismissAction },
    }),
    [plainMessage, showPlain, dismissPlain, actionUp, showAction, dismissAction],
  );
}
