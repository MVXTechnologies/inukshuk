import { useCallback, useEffect, useState } from 'react';

import {
  isOfferNewer,
  isUpdateCheckDue,
  isUpdatePromptVisible,
  offerKey,
  phaseFromPlayStatus,
  updatePromptCopy,
  type UpdateCheckState,
  type UpdatePhase,
} from '@core/app/storeUpdate';
import {
  fetchStoreAnswer,
  installDownloadedUpdate,
  openStorePage,
  readUpdateCheckState,
  runningBinary,
  saveUpdateCheckState,
  startStoreUpdate,
} from '@data/storeUpdate';
import { onPlayInstallState } from '@lib/playAppUpdate';
import { useRecorderStore } from '@state/recorderStore';
import { useTeamStore } from '@state/teamStore';

/**
 * The store check waits this long after the Map mounts: off the launch path,
 * after the map's own first work.
 */
export const UPDATE_CHECK_DELAY_MS = 8000;

/** One store check per app launch (a JS reload counts as a launch). */
let checkedThisLaunch = false;

/** Tests only: forget this launch's check. */
export function resetUpdateCheckForTests(): void {
  checkedThisLaunch = false;
}

/** What the Map draws, or null when no prompt is due. */
export interface StoreUpdatePrompt {
  text: string;
  /** The button's word, or null (no button while the download runs). */
  action: string | null;
  /** The button's spoken label. */
  actionLabel: string | null;
  onAction: () => void;
  onDismiss: () => void;
}

/**
 * The "New version" prompt (2.7.0): checks the store at most once per launch
 * and once a day, remembers the offer until it is installed and a dismissal
 * per version, and stays off screen while a trail records or an SOS is live.
 * Every failure is silent: no prompt.
 */
export function useStoreUpdatePrompt(): StoreUpdatePrompt | null {
  const recording = useRecorderStore((s) => s.status !== 'idle');
  const sosActive = useTeamStore((s) => s.sosAlarm !== null || s.soses.some((x) => !x.resolved));
  const [state, setState] = useState<UpdateCheckState | null>(null);
  const [phase, setPhase] = useState<UpdatePhase>({ kind: 'available' });

  useEffect(() => {
    let live = true;
    const run = async () => {
      const saved = await readUpdateCheckState();
      // A remembered offer shows until it is installed.
      let next: UpdateCheckState = {
        ...saved,
        offer:
          saved.offer !== null && isOfferNewer(saved.offer, runningBinary()) ? saved.offer : null,
      };
      if (live) setState(next);
      if (!isUpdateCheckDue(saved, Date.now(), checkedThisLaunch)) return;
      checkedThisLaunch = true;
      const answer = await fetchStoreAnswer();
      if (answer === null) return;
      next = {
        ...next,
        lastCheckAt: Date.now(),
        offer: answer.offer,
        // Play still holds an accepted download: ask again next launch.
        downloadPending: answer.offer !== null && answer.phase.kind !== 'available',
      };
      saveUpdateCheckState(next);
      if (live) {
        setState(next);
        setPhase(answer.phase);
      }
    };
    const timer = setTimeout(() => {
      run().catch(() => {
        // Silent by design: no prompt.
      });
    }, UPDATE_CHECK_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);

  // Play's background download (Android; a no-op elsewhere).
  useEffect(
    () =>
      onPlayInstallState((s) => {
        const p = phaseFromPlayStatus(s.status, s.bytesDownloaded, s.totalBytes);
        if (p !== null) setPhase(p);
      }),
    [],
  );

  const offer = state?.offer ?? null;

  const onAction = useCallback(() => {
    if (state === null || offer === null) return;
    if (phase.kind === 'downloaded') {
      void installDownloadedUpdate().then((ok) => {
        if (!ok) void openStorePage(offer);
      });
      return;
    }
    if (phase.kind === 'downloading') return;
    void startStoreUpdate(offer).then((result) => {
      if (result !== 'started') return;
      setPhase((p) => (p.kind === 'available' ? { kind: 'downloading', fraction: null } : p));
      const next = { ...state, downloadPending: true };
      saveUpdateCheckState(next);
      setState(next);
    });
  }, [state, offer, phase.kind]);

  const onDismiss = useCallback(() => {
    if (state === null || state.offer === null) return;
    const next = { ...state, dismissed: offerKey(state.offer) };
    saveUpdateCheckState(next);
    setState(next);
  }, [state]);

  if (
    offer === null ||
    !isUpdatePromptVisible({ offer, dismissed: state?.dismissed ?? null, recording, sosActive })
  ) {
    return null;
  }
  return { ...updatePromptCopy(offer, phase), onAction, onDismiss };
}
