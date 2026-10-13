import { useCallback, useEffect, useRef, useState } from 'react';

/** One button on an action snackbar ("EDIT", "UNDO"). */
export interface SnackAction {
  label: string;
  onPress: () => void;
}

export interface ActionSnack {
  message: string;
  actions: readonly SnackAction[];
  /** Bumped on every show, so a repeat of the same text still restarts. */
  seq: number;
}

export interface ActionSnackbarState {
  /** The snackbar up now, or null. */
  current: ActionSnack | null;
  show: (message: string, actions?: readonly SnackAction[]) => void;
  dismiss: () => void;
}

/**
 * A snackbar with up to a couple of actions (#671 EDIT / UNDO, #676 UNDO),
 * with the SAME self-owned timer as `useTimedSnackbar`: dismissal is a plain
 * JS timeout, never an animation callback, because Paper's Snackbar arms its
 * timer only in a show-animation callback that One UI does not always fire
 * (paper-snackbar-sticks-on-samsung). Pair with `<ActionSnackbar>`, a plain
 * View — not Paper's Snackbar, which takes a single action anyway.
 *
 * Tapping an action dismisses first, then runs it.
 */
export function useActionSnackbar(durationMs = 6000): ActionSnackbarState {
  const [current, setCurrent] = useState<ActionSnack | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const seq = useRef(0);

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
  };

  const dismiss = useCallback(() => {
    clear();
    setCurrent(null);
  }, []);

  const show = useCallback(
    (message: string, actions: readonly SnackAction[] = []) => {
      clear();
      seq.current += 1;
      const wrapped = actions.map((a) => ({
        label: a.label,
        onPress: () => {
          clear();
          setCurrent(null);
          a.onPress();
        },
      }));
      setCurrent({ message, actions: wrapped, seq: seq.current });
      timer.current = setTimeout(() => {
        timer.current = undefined;
        setCurrent(null);
      }, durationMs);
    },
    [durationMs],
  );

  useEffect(() => clear, []);

  return { current, show, dismiss };
}
