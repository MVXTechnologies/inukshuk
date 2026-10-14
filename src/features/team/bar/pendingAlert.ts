/**
 * The sender's side of an SOS or "Rally here" (#708): a pending alert with a
 * {@link UNDO_MS} countdown. Nothing leaves the phone until the countdown
 * ends; Undo drops it without a trace, so an undone alert never notifies
 * anyone. One at a time: a new one replaces (and cancels) the previous.
 *
 * The countdown runs here, not in the snackbar: the alert is sent even if
 * the snackbar unmounts (another tab, a sheet over it).
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

interface PendingStore {
  pending: PendingAlert | null;
  /** Why the last send failed, for the snackbar to say (null: fine). */
  error: string | null;
  start(kind: PendingKind, at: [number, number]): void;
  undo(): void;
  clearError(): void;
}

let timer: ReturnType<typeof setTimeout> | null = null;

function stop(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

const ERRORS: Partial<Record<ActionError, string>> = {
  invalid: 'You already have an open SOS.',
  'not-allowed': 'Not sent: guests can’t call a rally.',
  'read-only': 'Not sent: the team is read-only.',
  'not-member': 'Not sent: you are no longer in the team.',
};

function send(p: PendingAlert): void {
  const session = teamService()?.active;
  if (!session) {
    usePendingAlert.setState({ pending: null, error: 'Not sent: no team is open.' });
    return;
  }
  const [lng, lat] = p.at;
  const err = p.kind === 'sos' ? session.raiseSos(lng, lat) : session.setRally(lng, lat);
  usePendingAlert.setState({
    pending: null,
    error: err === null ? null : (ERRORS[err] ?? 'Not sent. Try again.'),
  });
  useTeamStore.getState().refresh();
}

export const usePendingAlert = create<PendingStore>((set) => ({
  pending: null,
  error: null,
  start: (kind, at) => {
    stop();
    const p: PendingAlert = { kind, at, clock: countdown(Date.now()) };
    set({ pending: p, error: null });
    timer = setTimeout(() => {
      timer = null;
      send(p);
    }, UNDO_MS);
  },
  undo: () => {
    stop();
    set({ pending: null });
  },
  clearError: () => set({ error: null }),
}));
