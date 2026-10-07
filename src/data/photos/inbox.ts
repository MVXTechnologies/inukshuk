import { Directory, File } from 'expo-file-system';

import { inboxPath, PHOTO_INBOX } from '@core/photos/paths';
import { copyToServed } from '@data/localServer';
import { resolveDocumentPath } from '@data/storage';

/**
 * The resize inbox (#587): `.photo-inbox/`, the one photo folder the loopback
 * server may serve. A picked photo is copied here for the WebView worker and
 * deleted after its job. Kept apart from `photoFiles` so code that only reads
 * or deletes copies does not depend on the static server's native module.
 */

const fileAt = (path: string) => new File(resolveDocumentPath(path));

/** Lower-case extension of a picked file, for the inbox name. */
export function extensionOf(uri: string): string {
  const m = /\.([A-Za-z0-9]{1,5})(?:[?#].*)?$/.exec(uri);
  return m ? m[1]!.toLowerCase() : 'jpg';
}

/** Copy a picked photo into the served inbox for the resize worker; returns its document path. */
export async function stageForResize(sourceUri: string, jobId: string): Promise<string> {
  const path = inboxPath(jobId, extensionOf(sourceUri));
  await copyToServed(sourceUri, path);
  return path;
}

export function unstage(documentPath: string): void {
  try {
    const f = fileAt(documentPath);
    if (f.exists) f.delete();
  } catch {
    // Already gone; the launch-time clear catches anything left.
  }
}

/**
 * Empty the inbox (at launch: anything there is left from a crash, and it is
 * full-resolution photos WITH their EXIF/GPS, in a folder the loopback server
 * serves).
 *
 * Called once at module load of the root layout (`app/_layout.tsx`), before
 * anything mounts, so before the resize host writes its page here and before
 * any import can start. `inbox.guard.test.ts` holds that in place.
 */
export function clearPhotoInbox(): void {
  try {
    const dir = new Directory(resolveDocumentPath(PHOTO_INBOX));
    if (dir.exists) dir.delete();
  } catch {
    // best effort
  }
}
