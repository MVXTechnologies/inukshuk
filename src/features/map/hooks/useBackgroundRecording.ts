import {
  ensureBackgroundLocationPermission,
  mergeJournaledBackgroundPoints,
  startBackgroundLocationUpdates,
  stopBackgroundLocationUpdates,
} from '@lib/backgroundLocation';
import { useRecorderStore } from '@state/recorderStore';
import { useSettingsStore } from '@state/settingsStore';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';

export interface BackgroundRecordingControls {
  /** Show the "Allow all the time" rationale dialog. */
  bgRationaleVisible: boolean;
  /** The user's answer to the rationale (true → proceed to the system prompt). */
  respondToBgRationale: (allow: boolean) => void;
}

/**
 * Runs the OS-level background location task for the lifetime of an active
 * recording: started on 'recording' (after walking the Android 11+ two-step
 * permission flow, with a rationale dialog before the "Allow all the time"
 * system prompt), stopped on pause/stop/unmount. Mount this once — the
 * recording session hook owns it.
 *
 * Denials degrade gracefully: the Android foreground service records fine
 * with while-in-use permission; only when the task cannot start at all do we
 * warn that recording is foreground-only.
 */
export function useBackgroundRecording({
  showSnack,
}: {
  showSnack: (message: string) => void;
}): BackgroundRecordingControls {
  const status = useRecorderStore((s) => s.status);
  const minDisplacement = useSettingsStore((s) => s.minDisplacementM);

  const [bgRationaleVisible, setBgRationaleVisible] = useState(false);
  const pendingRationale = useRef<((allow: boolean) => void) | null>(null);

  const askRationale = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        pendingRationale.current = resolve;
        setBgRationaleVisible(true);
      }),
    [],
  );

  const respondToBgRationale = useCallback((allow: boolean) => {
    setBgRationaleVisible(false);
    pendingRationale.current?.(allow);
    pendingRationale.current = null;
  }, []);

  useEffect(() => {
    if (status !== 'recording') {
      // Covers pause/stop AND a fresh mount where a previous crash left the
      // OS-side task registered (it must not keep feeding a dead session).
      void stopBackgroundLocationUpdates();
      return;
    }
    let cancelled = false;
    void (async () => {
      const permission = await ensureBackgroundLocationPermission(askRationale);
      if (cancelled) return;
      const started = await startBackgroundLocationUpdates(minDisplacement);
      if (cancelled) {
        // Recording ended before the task finished starting — tear it down.
        void stopBackgroundLocationUpdates();
        return;
      }
      if (!started) {
        showSnack('Background tracking unavailable — keep Inukshuk open while recording');
      } else if (permission !== 'granted' && Platform.OS === 'ios') {
        // Android's foreground service records regardless; iOS without
        // "Always" may be suspended once the app leaves the foreground.
        showSnack('Without "Always" location, recording may stop in the background');
      }
    })();
    return () => {
      cancelled = true;
      void stopBackgroundLocationUpdates();
    };
  }, [status, minDisplacement, askRationale, showSnack]);

  // Fixes journaled while the JS process was dead (headless background
  // deliveries) are folded into the live session whenever the app foregrounds.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void mergeJournaledBackgroundPoints();
    });
    return () => sub.remove();
  }, []);

  return { bgRationaleVisible, respondToBgRationale };
}
