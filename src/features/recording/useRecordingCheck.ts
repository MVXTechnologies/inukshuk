import { hasProblem, readinessChecks } from '@core/recording/recordingReadiness';
import { suppressBackgroundRationaleThisSession } from '@lib/backgroundLocation';
import { readReadinessSnapshot } from '@lib/recordingReadiness';
import { useSettingsStore } from '@state/settingsStore';
import { useCallback, useRef, useState } from 'react';
import type { RecordingCheckMode } from './RecordingCheckPanel';

interface PanelState {
  mode: RecordingCheckMode;
  incident: string | null;
}

export interface RecordingCheckControls {
  /**
   * Gate a recording start: the first time ever, and whenever a row reports a
   * problem (no location, approximate location), show the check first; else
   * start straight away.
   */
  requestStart: (start: () => void) => void;
  /** Show the check with what went wrong (from useRecordingHealth). */
  openReview: (incident: string) => void;
  /** Props for `<RecordingCheckPanel>`. */
  panel: {
    visible: boolean;
    mode: RecordingCheckMode;
    incident: string | null;
    onStart: () => void;
    onClose: () => void;
  };
}

export function useRecordingCheck(): RecordingCheckControls {
  const shown = useSettingsStore((s) => s.recordingCheckShown);
  const setSetting = useSettingsStore((s) => s.set);
  const [state, setState] = useState<PanelState | null>(null);
  const pendingStart = useRef<(() => void) | null>(null);

  const markShown = useCallback(() => {
    if (useSettingsStore.getState().recordingCheckShown) return;
    try {
      setSetting('recordingCheckShown', true);
    } catch {
      /* worst case the check shows once more */
    }
  }, [setSetting]);

  const requestStart = useCallback(
    (start: () => void) => {
      if (!shown) {
        // Synchronous on first use: the panel mounts in the same render that
        // hides the category sheet (no flash of the map, deterministic E2E).
        pendingStart.current = start;
        setState({ mode: 'preflight', incident: null });
        return;
      }
      void (async () => {
        let problem = false;
        try {
          const snap = await readReadinessSnapshot(
            useSettingsStore.getState().recordingBatteryReviewed,
          );
          problem = hasProblem(readinessChecks(snap));
        } catch {
          /* unknown → don't block the start */
        }
        if (problem) {
          pendingStart.current = start;
          setState({ mode: 'preflight', incident: null });
        } else {
          start();
        }
      })();
    },
    [shown],
  );

  const openReview = useCallback((incident: string) => {
    pendingStart.current = null;
    setState({ mode: 'review', incident });
  }, []);

  const onStart = useCallback(() => {
    const start = pendingStart.current;
    pendingStart.current = null;
    setState(null);
    markShown();
    // The user just read the screen-off advice: the Android rationale card
    // must not ask the same question again on this start.
    suppressBackgroundRationaleThisSession();
    start?.();
  }, [markShown]);

  const onClose = useCallback(() => {
    pendingStart.current = null;
    if (state?.mode === 'preflight') markShown();
    setState(null);
  }, [state, markShown]);

  return {
    requestStart,
    openReview,
    panel: {
      visible: state !== null,
      mode: state?.mode ?? 'settings',
      incident: state?.incident ?? null,
      onStart,
      onClose,
    },
  };
}
