import { useMapStore } from '@state/mapStore';
import { useRecorderStore } from '@state/recorderStore';
import { useSettingsStore } from '@state/settingsStore';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useEffect, useState } from 'react';

/**
 * Recording lifecycle for the map screen: recorder-store state/actions, the
 * live elapsed-time ticker, the keep-awake guard while recording, and the
 * start/stop handlers.
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
  const start = useRecorderStore((s) => s.start);
  const pause = useRecorderStore((s) => s.pause);
  const resume = useRecorderStore((s) => s.resume);
  const stop = useRecorderStore((s) => s.stop);
  const addWaypoint = useRecorderStore((s) => s.addWaypoint);
  const waypoints = useRecorderStore((s) => s.waypoints);
  const updateWaypoint = useRecorderStore((s) => s.updateWaypoint);
  const removeWaypoint = useRecorderStore((s) => s.removeWaypoint);

  const [elapsedS, setElapsedS] = useState(0);

  // Live elapsed timer, independent of GPS fix cadence. Excludes paused wall
  // time (pausedMs) so resuming continues from where the display froze instead
  // of jumping forward by the whole pause.
  useEffect(() => {
    if (status !== 'recording' || startedAt === null) return;
    const tick = () => setElapsedS(Math.floor((Date.now() - startedAt - pausedMs) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [status, startedAt, pausedMs]);

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
  const startRecording = () => {
    if (terrain3d) toggleTerrain3d();
    start();
  };

  const handleStop = async () => {
    const track = await stop();
    setElapsedS(0);
    showSnack(
      track && track.points.length > 0
        ? `Saved "${track.name}"`
        : 'Recording discarded (no points)',
    );
  };

  return {
    status,
    name,
    stats,
    points,
    waypoints,
    elapsedS,
    pause,
    resume,
    startRecording,
    handleStop,
    addWaypoint,
    updateWaypoint,
    removeWaypoint,
  };
}
