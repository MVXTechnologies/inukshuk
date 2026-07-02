import { importGpxFromUri } from '@features/library/importGpx';
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
  if (/^(content|file):\/\//i.test(path)) {
    try {
      // On a cold start this runs concurrently with RootLayout's hydrate();
      // adding a track before the on-disk index is loaded would persist an
      // index built from the empty initial state and wipe the library.
      await useLibraryStore.getState().hydrate();
      const { track, fileUri, notes } = await importGpxFromUri(path, 'Imported trail');
      useLibraryStore.getState().addTrack(track, fileUri, notes);
      useImportFeedbackStore.getState().show(`Imported ${track.name}`);
    } catch {
      useImportFeedbackStore.getState().show('Could not import that file');
    }
    // Land on the Library regardless, so the opened URI never reaches routing.
    return '/(tabs)/library';
  }
  return path;
}
