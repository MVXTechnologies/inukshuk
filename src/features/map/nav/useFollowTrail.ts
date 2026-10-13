import type { LatLng } from '@core/models';
import {
  buildFollowTargets,
  createFollowSession,
  prepareTrail,
  trailPathCoordinates,
  type FollowReadout,
  type PreparedTrail,
} from '@core/nav';
import { readTrailPoints } from '@data/trailStatsStore';
import { useLibraryStore } from '@state/libraryStore';
import { useNavigationStore } from '@state/navigationStore';
import { useEffect, useMemo, useState } from 'react';

export interface FollowState {
  /** The followed trail's name (the top chip). */
  name: string;
  /** Null until the trail is loaded and there is a fix. */
  readout: FollowReadout | null;
  /** The followed trail's lines (`[lon, lat]`, split at pauses), once loaded. */
  path?: [number, number][][] | null;
}

/**
 * Following a saved trail (#678): loads the followed trail's points once,
 * prepares them (`@core/nav`, O(n) once), and turns every fix into the
 * compass's readout.
 *
 * Per fix this is one `FollowSession.update` — a short window search on the
 * trail, an O(log n) lookahead and an O(log k) target pick (see
 * `@core/nav/trailTracker`) — run in a memo on the fix MapScreen already
 * re-renders for, so it adds no render of its own. Heading never reaches
 * here: the compass leaf subscribes to it.
 *
 * The session (your place on the trail and your progress) lives as long as
 * the trail: a library change only swaps its targets (`setTargets`), and only
 * when the targets of THIS trail actually changed — adding a waypoint
 * mid-follow must not send you back to the start of an out-and-back.
 *
 * Stops following (and says so) if the trail can't be read or is deleted.
 */
export function useFollowTrail(
  location: LatLng | null,
  onMessage: (message: string) => void,
): FollowState | null {
  const following = useNavigationStore((s) => s.following);
  const stopFollowing = useNavigationStore((s) => s.stopFollowing);
  const track = useLibraryStore((s) =>
    following === null ? undefined : s.tracks.find((t) => t.id === following.trackId),
  );
  const hydrated = useLibraryStore((s) => s.hydrated);
  const waypoints = useLibraryStore((s) => s.waypoints);
  const [prepared, setPrepared] = useState<{ fileUri: string; trail: PreparedTrail } | null>(null);

  const fileUri = track?.fileUri ?? null;
  useEffect(() => {
    if (fileUri === null || track === undefined) return;
    let cancelled = false;
    void readTrailPoints(track).then((loaded) => {
      if (cancelled) return;
      const trail = loaded ? prepareTrail(loaded.points, loaded.segmentStarts) : null;
      if (trail === null) {
        stopFollowing();
        onMessage("Couldn't read that trail to follow it");
        return;
      }
      setPrepared({ fileUri, trail });
    });
    return () => {
      cancelled = true;
    };
    // Reload only when the trail's file changes (not on a rename or a note edit).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileUri]);

  // The followed trail was deleted: stop.
  useEffect(() => {
    if (following !== null && track === undefined && hydrated) stopFollowing();
  }, [following, track, hydrated, stopFollowing]);

  const trail = prepared !== null && prepared.fileUri === fileUri ? prepared.trail : null;
  const notes = track?.notes;
  // The targets, derived per library change: one grid query per waypoint,
  // never per fix.
  const targets = useMemo(
    () => (trail === null ? null : buildFollowTargets(trail, waypoints, notes ?? [])),
    [trail, waypoints, notes],
  );
  // Its line for the map, built once per trail (O(n)), never per fix.
  const path = useMemo(() => (trail === null ? null : trailPathCoordinates(trail)), [trail]);
  // One session per trail: it holds your progress, so it never restarts on a
  // target change (see setTargets).
  const session = useMemo(
    () => (trail === null ? null : createFollowSession(trail, buildFollowTargets(trail, [], []))),
    [trail],
  );
  // The session is stateful (it tracks your progress), and updating it twice
  // with the same fix is harmless, so a memo on the fix is the right home.
  // New targets re-run it once on the current fix, so the flag moves at once
  // (one tracker update on a fix it already holds: a few projections).
  const readout = useMemo(() => {
    if (session === null || targets === null || location === null) return null;
    session.setTargets(targets);
    return session.update(location);
  }, [session, targets, location]);

  if (following === null) return null;
  return { name: track?.name ?? following.name, readout, path };
}
