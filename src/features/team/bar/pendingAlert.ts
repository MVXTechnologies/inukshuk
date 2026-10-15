/**
 * The sender's side of an SOS or "Rally here" (#708): a pending alert with a
 * {@link UNDO_MS} countdown. Nothing leaves the phone until the countdown
 * ends; Undo drops it without a trace, so an undone alert never notifies
 * anyone. One at a time: a new one replaces (and cancels) the previous.
 *
 * The countdown runs here, not in the snackbar: the alert is sent even if
 * the snackbar unmounts (another tab, a sheet over it).
 *
 * A send that fails, for any reason, is a {@link AlertFailure} that stays on
 * screen with Retry until the user retries or dismisses it: never a timer's
 * call (QA 2.6.1: an SOS refused by the team vanished with its countdown).
 */
import { countdown, UNDO_MS, type Countdown } from '@core/teamui/undo';
import type { ActionError } from '@data/team/teamSession';
import { teamService, useTeamStore } from '@state/teamStore';
import { create } from 'zustand';

export type PendingKind = 'sos' | 'rally';

export interface PendingAlert {
  kind: PendingKind;
  /** Where, `[lng, lat]`. */
  at: [number, number];
  clock: Countdown;
}

/** Why an alert did not go out, for the snackbar to say. */
export interface AlertFailure {
  text: string;
  /** What Retry sends again at once (null: nothing to retry). */
  retry: { kind: PendingKind; at: [number, number] } | null;
  /** Stays until Retry or Dismiss (every failed send); otherwise a short notice. */
  sticky: boolean;
}

interface PendingStore {
  pending: PendingAlert | null;
  /** Why the last send failed (null: fine). */
  error: AlertFailure | null;
  start(kind: PendingKind, at: [number, number]): void;
  undo(): void;
  /** Send the failed alert again, now (its hold and undo already confirmed it). */
  retry(): void;
  /** Show a failure (a send that could not even start, e.g. no position). */
  fail(error: AlertFailure): void;
  clearError(): void;
}

let timer: ReturnType<typeof setTimeout> | null = null;

function stop(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

const SOS_ERRORS: Partial<Record<ActionError, string>> = {
  'not-allowed': 'SOS not sent: the team refused it.',
  'read-only': 'SOS not sent: the team is read-only.',
  'not-member': 'SOS not sent: you are no longer in the team.',
  'rotation-pending': 'SOS not sent: the team is changing its keys.',
};

const RALLY_ERRORS: Partial<Record<ActionError, string>> = {
  'not-allowed': 'Rally point not set: guests can’t call a rally.',
  'read-only': 'Rally point not set: the team is read-only.',
  'not-member': 'Rally point not set: you are no longer in the team.',
  'rotation-pending': 'Rally point not set: the team is changing its keys.',
};

/** The words for a failed send of `kind` (`reason` null: no team, or it threw). */
export function failureText(kind: PendingKind, reason: ActionError | 'no-team' | null): string {
  const what = kind === 'sos' ? 'SOS not sent' : 'Rally point not set';
  if (reason === 'no-team') return `${what}: no team is open.`;
  const known = reason === null ? undefined : (kind === 'sos' ? SOS_ERRORS : RALLY_ERRORS)[reason];
  return known ?? `${what}. Try again.`;
}

function send(kind: PendingKind, at: [number, number]): void {
  const failed = (reason: ActionError | 'no-team' | null): AlertFailure => ({
    text: failureText(kind, reason),
    retry: { kind, at },
    sticky: true,
  });
  let error: AlertFailure | null;
  try {
    const session = teamService()?.active;
    if (!session) {
      error = failed('no-team');
    } else {
      const [lng, lat] = at;
      const err = kind === 'sos' ? session.raiseSos(lng, lat) : session.setRally(lng, lat);
      error =
        err === null
          ? null
          : kind === 'sos' && err === 'invalid'
            ? // My SOS is already open (another phone of mine, a sync): it is out.
              { text: 'Your SOS is already active.', retry: null, sticky: false }
            : failed(err);
    }
  } catch {
    error = failed(null);
  }
  usePendingAlert.setState({ pending: null, error });
  try {
    useTeamStore.getState().refresh();
  } catch {
    // The send's outcome is already on screen; the next refresh catches up.
  }
}

export const usePendingAlert = create<PendingStore>((set, get) => ({
  pending: null,
  error: null,
  start: (kind, at) => {
    stop();
    const p: PendingAlert = { kind, at, clock: countdown(Date.now()) };
    set({ pending: p, error: null });
    timer = setTimeout(() => {
      timer = null;
      send(p.kind, p.at);
    }, UNDO_MS);
  },
  undo: () => {
    stop();
    set({ pending: null });
  },
  retry: () => {
    const r = get().error?.retry;
    if (r == null || get().pending !== null) return;
    send(r.kind, r.at);
  },
  // Never cancels a pending alert: a rally that can't start leaves an SOS countdown running.
  fail: (error) => set({ error }),
  clearError: () => set({ error: null }),
}));
