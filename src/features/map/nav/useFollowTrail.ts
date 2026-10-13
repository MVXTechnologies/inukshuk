import type { LatLng } from '@core/models';
import {
  buildFollowTargets,
  createFollowSession,
  prepareTrail,
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
  const session = useMemo(
    () =>
      trail === null
        ? null
        : createFollowSession(trail, buildFollowTargets(trail, waypoints, notes ?? [])),
    [trail, waypoints, notes],
  );
  // The session is stateful (it tracks your progress), and updating it twice
  // with the same fix is harmless, so a memo on the fix is the right home.
  const readout = useMemo(
    () => (session !== null && location !== null ? session.update(location) : null),
    [session, location],
  );

  if (following === null) return null;
  return { name: track?.name ?? following.name, readout };
}
