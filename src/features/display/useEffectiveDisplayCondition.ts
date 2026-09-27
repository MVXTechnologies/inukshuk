import { effectiveCondition, type DisplayCondition } from '@core/display/condition';
import { sunTimes } from '@core/sun/sunTimes';
import { useDisplayStore } from '@state/displayStore';
import { useRecorderStore } from '@state/recorderStore';
import { useSettingsStore } from '@state/settingsStore';
import { useEffect, useMemo, useState } from 'react';

/** Re-evaluate auto night once a minute: sunset needn't be caught to the second. */
const TICK_MS = 60_000;

/**
 * The display mode in effect right now, from the chosen mode, the two opt-in
 * toggles, whether a recording runs, and today's sun times at the last known
 * position.
 */
export function useEffectiveDisplayCondition(): DisplayCondition {
  const chosen = useSettingsStore((s) => s.displayCondition);
  const autoNightAtSunset = useSettingsStore((s) => s.autoNightAtSunset);
  const sunlightWhileRecording = useSettingsStore((s) => s.sunlightWhileRecording);
  const position = useSettingsStore((s) => s.lastKnownPosition);
  const recording = useRecorderStore((s) => s.status !== 'idle');
  const dismissedUntil = useDisplayStore((s) => s.autoNightDismissedUntil);
  const now = useMinuteClock(autoNightAtSunset);

  const sun = useMemo(
    () => (position === null ? null : sunTimes(now, position.latitude, position.longitude)),
    [now, position],
  );
  return effectiveCondition({
    chosen,
    autoNightAtSunset,
    sunlightWhileRecording,
    recording,
    now,
    sun,
    autoNightDismissedUntil: dismissedUntil,
  });
}

/** Wall-clock time, refreshed each minute while `active`. */
function useMinuteClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [active]);
  return now;
}
