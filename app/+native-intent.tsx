import { findDuplicateTrack } from '@features/share/findDuplicateTrack';
import { importGpxFromUri } from '@features/library/importGpx';
import {
  activityImportMessage,
  importActivitiesFromUri,
  openImportedUri,
} from '@features/library/importActivities';
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
    return '/settings';
  }
  if (/^(content|file):\/\//i.test(path)) {
    addBreadcrumb('open-with intent received');
    try {
      // On a cold start this runs concurrently with RootLayout's hydrate();
      // adding a track before the on-disk index is loaded would persist an
      // index built from the empty initial state and wipe the library.
      await useLibraryStore.getState().hydrate();
      // FIT / TCX / gzip / zip (Strava & Garmin exports, #431) are sniffed by
      // content; plain GPX (and anything unrecognized) keeps the GPX path below.
      const opened = await openImportedUri(path);
      if (opened.format !== 'gpx' && opened.format !== 'unknown') {
        try {
          return await importOpenedActivities(opened.uri);
        } finally {
          opened.dispose();
        }
      }
      opened.dispose();
      const incoming = await importGpxFromUri(path, 'Imported trail');
      const { track, fileUri, notes } = incoming;
      const existing = await findDuplicateTrack(incoming, useLibraryStore.getState().tracks);
      // Async comparison can outlive a deletion, trim, or note edit. Only the
      // exact surviving summary still owns the content we just compared.
      if (existing && useLibraryStore.getState().tracks.includes(existing)) {
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

/**
 * Import an opened FIT / TCX / gzip / zip file: one activity goes straight to
 * its trail view (like a GPX); an export archive lands on the Library with a
 * summary. Throws when nothing could be read, for the caller's error path.
 */
async function importOpenedActivities(uri: string): Promise<string> {
  const feedback = useImportFeedbackStore.getState();
  let lastProgressAt = 0;
  const summary = await importActivitiesFromUri(
    uri,
    'Imported activity',
    useLibraryStore.getState().tracks,
    (done, total) => {
      const now = Date.now();
      if (total < 10 || now - lastProgressAt < 1000) return;
      lastProgressAt = now;
      feedback.show(`Importing activities… ${done} of ${total}`);
    },
  );
  const { items, duplicates } = summary;
  if (items.length === 0 && duplicates === 0) throw new Error('No activities found');
  useLibraryStore.getState().addTracks(items);
  const [only] = items;
  if (only && items.length === 1 && duplicates === 0 && summary.failed === 0) {
    feedback.show(`Imported ${only.track.name}`);
    return `/trail3d/${only.track.id}`;
  }
  feedback.show(items.length === 0 ? 'Already in your library' : activityImportMessage(summary));
  return '/(tabs)/library';
}
