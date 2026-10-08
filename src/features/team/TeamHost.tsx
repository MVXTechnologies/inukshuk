/**
 * Team mode's lifecycle, app-wide (root layout, #589). Renders nothing.
 *
 * - Reopens the last team at launch, once the extension is installed.
 * - Runs the active team's mesh while the app is in the foreground, and in
 *   the background ONLY while a recording runs (its location background mode
 *   keeps the app alive; using location as a keep-alive for networking alone
 *   would break App Review 2.5.4 — docs/design/team-mesh.md "Background").
 * - Shares my position, only while I have sharing on (and, by default, only
 *   while recording — owner B9), at my chosen interval: from the recorder's
 *   fixes while recording, else from a foreground location watch.
 * - Buzzes for `alert`-level team messages (the core's routing: chatter in
 *   a team of more than 30 doesn't buzz).
 */
import { useExtensionPrefs } from '@features/extensions/prefs';
import { reportError } from '@lib/errorReporting';
import { useRecorderStore } from '@state/recorderStore';
import { teamService, useTeamStore, wireTeamStore } from '@state/teamStore';
import * as Location from 'expo-location';
import { useEffect, useRef, useState } from 'react';
import { AppState, Vibration, type AppStateStatus } from 'react-native';
import { onTeamNotificationTap } from '@data/team/teamNotifications';
import { useRouter } from 'expo-router';

export function TeamHost() {
  const { installedAt, show } = useExtensionPrefs('team');
  const enabled = installedAt > 0 && show;
  const loaded = useTeamStore((s) => s.loaded);
  const activeId = useTeamStore((s) => s.activeId);
  const joining = useTeamStore((s) => s.join !== null);
  const recording = useRecorderStore((s) => s.status !== 'idle');
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    if (installedAt > 0) wireTeamStore();
  }, [installedAt]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', setAppState);
    return () => sub.remove();
  }, []);

  // Reopen the team used last.
  useEffect(() => {
    const service = teamService();
    if (!enabled || !loaded || service === null || service.active !== null) return;
    const last = service.lastOpened;
    if (last) service.activate(last.teamId).catch((e) => reportError(e, 'team-open'));
  }, [enabled, loaded, activeId]);

  // Demo builds only: a running team simulation picks up where it was (the
  // inlined flag drops this require from store builds).
  useEffect(() => {
    // The whole block is the folded condition, so the require goes with it.
    if (process.env.EXPO_PUBLIC_MESH_LOOPBACK === '1') {
      if (activeId !== null) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const sim = require('./sim/teamSimulation') as typeof import('./sim/teamSimulation');
        void sim.teamSimulation.resume();
      }
    }
  }, [activeId]);

  // The mesh: foreground, or background while recording; never during a join
  // (the join owns the transport).
  const foreground = appState === 'active';
  const wantMesh = enabled && activeId !== null && !joining && (foreground || recording);
  useEffect(() => {
    const session = teamService()?.active ?? null;
    if (session === null) return;
    if (wantMesh) session.startMesh().catch((e) => reportError(e, 'team-mesh-start'));
    else session.stopMesh().catch((e) => reportError(e, 'team-mesh-stop'));
  }, [wantMesh, activeId]);

  // Back in the foreground: re-sync at once instead of waiting for the timer.
  useEffect(() => {
    if (foreground) teamService()?.active?.tick();
  }, [foreground]);

  // Tapping a team notification opens what it is about.
  const router = useRouter();
  useEffect(() => {
    if (installedAt === 0) return;
    return onTeamNotificationTap((url) => router.push(url as never));
  }, [installedAt, router]);

  usePositionSharing(wantMesh, recording, foreground);
  useAlertBuzz();
  return null;
}

/** The interval and on/off come from the active team's local prefs. */
function usePositionSharing(meshOn: boolean, recording: boolean, foreground: boolean) {
  const record = useTeamStore((s) => s.record);
  const prefs = record?.prefs;
  const share =
    meshOn &&
    prefs !== undefined &&
    prefs.sharePosition &&
    (!prefs.shareOnlyWhileRecording || recording);
  const intervalMs = Math.max(10, prefs?.shareIntervalS ?? 60) * 1000;
  const lastSent = useRef(0);

  // While recording: the recorder's own fixes (no second GPS client).
  useEffect(() => {
    if (!share || !recording) return;
    return useRecorderStore.subscribe((s) => {
      const p = s.points[s.points.length - 1];
      const now = Date.now();
      if (p === undefined || now - lastSent.current < intervalMs) return;
      lastSent.current = now;
      teamService()?.active?.sharePosition({
        latitude: p.latitude,
        longitude: p.longitude,
        accuracy: p.accuracy ?? null,
        altitude: p.altitude ?? null,
        at: p.time || now,
      });
    });
  }, [share, recording, intervalMs]);

  // Not recording (sharing set to "always while the app is open"): a
  // foreground watch at the sharing interval.
  useEffect(() => {
    if (!share || recording || !foreground) return;
    let sub: Location.LocationSubscription | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const perm = await Location.getForegroundPermissionsAsync();
        if (!perm.granted || cancelled) return;
        sub = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.Balanced,
            timeInterval: intervalMs,
            distanceInterval: 10,
          },
          (fix) => {
            const now = Date.now();
            if (now - lastSent.current < intervalMs * 0.8) return;
            lastSent.current = now;
            teamService()?.active?.sharePosition({
              latitude: fix.coords.latitude,
              longitude: fix.coords.longitude,
              accuracy: fix.coords.accuracy,
              altitude: fix.coords.altitude,
              at: fix.timestamp,
            });
          },
        );
        if (cancelled) sub.remove();
      } catch (e) {
        reportError(e, 'team-position-watch');
      }
    })();
    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [share, recording, foreground, intervalMs]);
}

/** Vibrate for alert-level messages (urgent, mentions, important from an admin). */
function useAlertBuzz() {
  const banner = useTeamStore((s) => s.banner);
  useEffect(() => {
    if (banner?.level === 'alert')
      Vibration.vibrate(banner.priority === 2 ? [0, 300, 150, 300] : 250);
  }, [banner]);
}
