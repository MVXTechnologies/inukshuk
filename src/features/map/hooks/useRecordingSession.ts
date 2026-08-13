import { gpsQualityLevel } from '@core/geo/track/gpsQuality';
import { liveSpeed } from '@core/geo/track/liveSpeed';
import { useMapStore } from '@state/mapStore';
import { initRecorderRecovery, useRecorderStore } from '@state/recorderStore';
import { useSettingsStore } from '@state/settingsStore';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useEffect, useMemo, useState } from 'react';
import { useBackgroundRecording } from './useBackgroundRecording';

/**
 * Recording lifecycle for the map screen: recorder-store state/actions, the
 * live elapsed-time ticker, the keep-awake guard while recording, the
 * background foreground-service feed, crash recovery, and the start/stop
 * handlers.
 */
export function useRecordingSession({ showSnack }: { showSnack: (message: string) => void }) {
  const keepAwake = useSettingsStore((s) => s.keepAwakeWhileRecording);
  const terrain3d = useMapStore((s) => s.terrain3d);
  const toggleTerrain3d = useMapStore((s) => s.toggleTerrain3d);

  const status = useRecorderStore((s) => s.status);
  const name = useRecorderStore((s) => s.name);
  const stats = useRecorderStore((s) => s.stats);
  const points = useRecorderStore((s) => s.points);
  const startedAt = useRecorderStore((s) => s.startedAt);
  const pausedMs = useRecorderStore((s) => s.pausedMs);
  const lastFixAt = useRecorderStore((s) => s.lastFixAt);
  const lastAccuracyM = useRecorderStore((s) => s.lastAccuracyM);
  const start = useRecorderStore((s) => s.start);
  const pause = useRecorderStore((s) => s.pause);
  const resume = useRecorderStore((s) => s.resume);
  const stop = useRecorderStore((s) => s.stop);
  const addWaypoint = useRecorderStore((s) => s.addWaypoint);
  const waypoints = useRecorderStore((s) => s.waypoints);
  const updateWaypoint = useRecorderStore((s) => s.updateWaypoint);
  const removeWaypoint = useRecorderStore((s) => s.removeWaypoint);

  const [elapsedS, setElapsedS] = useState(0);
  // Wall-clock sample taken by the ticker below, so GPS staleness can be
  // DERIVED rather than stored — see gpsQuality.
  const [tickAt, setTickAt] = useState(() => Date.now());

  // Instantaneous speed for the HUD's "Speed" tile — see @core/geo/track/liveSpeed.
  // stats.avgSpeedMps is a WHOLE-SESSION moving average; on a long recording it
  // drifts toward the trip's overall average and can look "stuck" even as the
  // real speed changes a lot (the reported bug: cruising at 110 km/h read as
  // ~100, the ride's average up to that point). Recomputed from `points`
  // whenever a new fix is accepted.
  const liveSpeedMps = useMemo(() => liveSpeed(points), [points]);

  // OS-level background location feed while recording (foreground service on
  // Android, background mode on iOS), including the "Allow all the time"
  // permission flow and its rationale dialog.
  const { bgRationaleVisible, respondToBgRationale } = useBackgroundRecording({ showSnack });

  // One-shot crash recovery: if a previous session died mid-hike, restore its
  // checkpoint as a paused recording and tell the user.
  useEffect(() => {
    initRecorderRecovery()
      .then((recovered) => {
        if (recovered) showSnack('Recovered an interrupted recording — resume or stop to save');
      })
      // A corrupt checkpoint must never take the app down at launch. On any
      // failure the recovery layer discards the bad state (see
      // initRecorderRecovery) and we start clean rather than crash-looping.
      .catch(() => showSnack("Couldn't recover the previous recording — starting fresh"));
    // Mount-only: initRecorderRecovery is itself one-shot, and showSnack must
    // not retrigger recovery notices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live elapsed timer, independent of GPS fix cadence. Excludes paused wall
  // time (pausedMs) so resuming continues from where the display froze instead
  // of jumping forward by the whole pause.
  //
  // It also samples the wall clock for gpsQuality below. `lastFixAt` and
  // `lastAccuracyM` used to be deps of this effect, which tore the interval
  // down and rebuilt it on EVERY accepted GPS fix. The tick still ran
  // synchronously on each rebuild, so the displayed clock was never wrong —
  // but above 1 Hz (cycling, driving) the interval itself never survived long
  // enough to fire, and with NO fixes arriving it is the only thing keeping
  // the display alive.
  useEffect(() => {
    if (status !== 'recording' || startedAt === null) return;
    const tick = () => {
      const now = Date.now();
      setElapsedS(Math.floor((now - startedAt - pausedMs) / 1000));
      setTickAt(now);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [status, startedAt, pausedMs]);

  // Live GPS-quality level for the HUD, derived rather than stored.
  //
  // Staleness has to climb on the clock — growing to 'weak'/'lost' while fixes
  // STOP arriving is the whole signal — which is what `tickAt` supplies. But a
  // fix ARRIVING is news too, and a recovery indicator that lags up to a second
  // behind the fix that caused it is a worse HUD. A fix's own timestamp is
  // newer than the last tick, so taking the later of the two reports zero
  // staleness immediately, without a second state update or an extra effect.
  const gpsQuality = useMemo(
    () => gpsQualityLevel(lastFixAt, Math.max(tickAt, lastFixAt ?? 0), lastAccuracyM),
    [tickAt, lastFixAt, lastAccuracyM],
  );

  // Keep the screen on while actively recording (if enabled).
  useEffect(() => {
    if (status === 'recording' && keepAwake) {
      void activateKeepAwakeAsync('inukshuk-recording');
      return () => {
        void deactivateKeepAwake('inukshuk-recording');
      };
    }
    return undefined;
  }, [status, keepAwake]);

  // Recording and 3D don't mix (3D can crash mid-record), so drop out of 3D when
  // a recording starts — the 3D button is disabled for the duration anyway.
  // `category` is the activity category picked in the pre-record sheet; it rides
  // the recorder store through stop() into the saved trail's summary.
  const startRecording = (category?: string) => {
    if (terrain3d) toggleTerrain3d();
    start(undefined, category);
  };

  const handleStop = async () => {
    try {
      const track = await stop();
      setElapsedS(0);
      showSnack(
        track && track.points.length > 0
          ? `Saved "${track.name}"`
          : 'Recording discarded (no points)',
      );
    } catch {
      // stop() persists the GPX before it resets the store, so a write failure
      // (e.g. storage full) rejects with the session STILL intact — status
      // unchanged, crash checkpoint freshly written, timer still running. Don't
      // reset the UI as if it saved; tell the user so they can free space and
      // stop again, and the trail stays recoverable.
      showSnack('Couldn’t save your trail — storage may be full. Free up space and try again.');
    }
  };

  return {
    status,
    name,
    stats,
    points,
    waypoints,
    elapsedS,
    gpsQuality,
    liveSpeedMps,
    pause,
    resume,
    startRecording,
    handleStop,
    addWaypoint,
    updateWaypoint,
    removeWaypoint,
    bgRationaleVisible,
    respondToBgRationale,
  };
}
