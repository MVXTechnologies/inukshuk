import { importGpxFromUri } from '@features/library/importGpx';
import * as storage from '@data/storage';
import { addBreadcrumb, reportError } from '@lib/errorReporting';
import { handleStravaAuthRedirect } from '@lib/strava';
import { useImportFeedbackStore } from '@state/importFeedbackStore';
import { useLibraryStore } from '@state/libraryStore';

/**
 * Intercept incoming OS intents (e.g. "Open with Inukshuk" on a .gpx) BEFORE
 * expo-router tries to match them as routes — otherwise a content:// / file://
 * URI becomes an "Unmatched Route" screen.
 *
 * A file opened from a file manager arrives as a content:// URI that often has
 * NO filename/extension (e.g. content://media/external/downloads/123), so we
 * can't classify by extension. Instead we just try to read+parse it as GPX:
 * `importGpxFromUri` throws "No track points" if it isn't one. The trail name
 * comes from the GPX's own <metadata><name>, not the URI. This runs outside
 * React, so we use the stores' non-hook `.getState()` API.
 */
export async function redirectSystemPath({
  path,
  initial,
}: {
  path: string;
  initial: boolean;
}): Promise<string> {
  void initial;
  // Strava OAuth redirect (inukshuk://localhost/strava-auth?code=…): hand the
  // params to the waiting connect flow (src/lib/strava) and land on Settings —
  // the raw callback path must never reach routing as an Unmatched Route.
  if (handleStravaAuthRedirect(path)) {
    addBreadcrumb('strava oauth redirect received');
    return '/(tabs)/settings';
  }
  if (/^(content|file):\/\//i.test(path)) {
    addBreadcrumb('open-with intent received');
    try {
      // On a cold start this runs concurrently with RootLayout's hydrate();
      // adding a track before the on-disk index is loaded would persist an
      // index built from the empty initial state and wipe the library.
      await useLibraryStore.getState().hydrate();
      const { track, fileUri, notes } = await importGpxFromUri(path, 'Imported trail');
      // Dedupe: re-opening a file that's already in the library must not
      // clone it — match on name + point count + distance (a re-export of
      // the same recording), drop the fresh copy, and open the EXISTING one.
      const existing = useLibraryStore
        .getState()
        .tracks.find(
          (t) =>
            t.name === track.name &&
            t.stats.pointCount === track.stats.pointCount &&
            Math.abs(t.stats.distanceM - track.stats.distanceM) < 1,
        );
      if (existing) {
        storage.deleteFileAt(fileUri);
        useImportFeedbackStore.getState().show(`${existing.name} is already in your library`);
        return `/trail3d/${existing.id}`;
      }
      useLibraryStore.getState().addTrack(track, fileUri, notes);
      useImportFeedbackStore.getState().show(`Imported ${track.name}`);
      // Straight to the trail's focused view — not a Library detour.
      return `/trail3d/${track.id}`;
    } catch (err) {
      reportError(err, 'open-with-import');
      useImportFeedbackStore.getState().show('Could not import that file');
      return '/(tabs)/library';
    }
  }
  return path;
}
