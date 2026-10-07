import {
  readinessChecks,
  type ReadinessCheck,
  type ReadinessFix,
} from '@core/recording/recordingReadiness';
import { applyReadinessFix, readReadinessSnapshot } from '@lib/recordingReadiness';
import { useSettingsStore } from '@state/settingsStore';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

export interface RecordingReadiness {
  /** The check rows; null until the first read lands. */
  checks: ReadinessCheck[] | null;
  /** Run a row's fix, then re-read (settings round-trips re-read on return). */
  fix: (action: ReadinessFix) => Promise<void>;
}

/**
 * Live Recording-check rows while mounted: read on mount, after every fix, and
 * whenever the app returns to the foreground (the user coming back from a
 * settings page is exactly when a row may have turned green). The panel mounts
 * this only while visible, so a reopened check never shows stale rows.
 */
export function useRecordingReadiness(): RecordingReadiness {
  const batteryReviewed = useSettingsStore((s) => s.recordingBatteryReviewed);
  const setSetting = useSettingsStore((s) => s.set);
  const [checks, setChecks] = useState<ReadinessCheck[] | null>(null);
  const reviewedRef = useRef(batteryReviewed);
  // Monotonic read token: a slow read must not overwrite a newer one.
  const readSeq = useRef(0);

  useEffect(() => {
    reviewedRef.current = batteryReviewed;
  }, [batteryReviewed]);

  const refresh = useCallback(async () => {
    const seq = ++readSeq.current;
    const snap = await readReadinessSnapshot(reviewedRef.current);
    if (seq === readSeq.current) setChecks(readinessChecks(snap));
  }, []);

  useEffect(() => {
    void refresh();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    // A read landing after unmount is a harmless no-op setState.
    return () => sub.remove();
  }, [refresh, batteryReviewed]);

  const fix = useCallback(
    async (action: ReadinessFix) => {
      if (action === 'open-battery-settings') {
        // Android can't tell us the outcome: having opened the page counts.
        reviewedRef.current = true;
        try {
          setSetting('recordingBatteryReviewed', true);
        } catch {
          /* a failed settings write only means the row asks again */
        }
      }
      await applyReadinessFix(action);
      await refresh();
    },
    [refresh, setSetting],
  );

  return { checks, fix };
}
