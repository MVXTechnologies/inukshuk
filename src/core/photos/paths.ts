/**
 * Where trail photos live (#587), as document-relative paths (never absolute:
 * the iOS data container moves on every app update, #247).
 *
 *   photos/<trackId>/photos.json      the sidecar (metadata)
 *   photos/<trackId>/<id>.jpg         display copy
 *   photos/<trackId>/<id>.sq.jpg      240 px square thumb
 *   photos/<trackId>/<id>.map2.png    264 px round map sprite (`.map.png`: the
 *                                     132 px ones made before 2026-10-07)
 *   .photo-inbox/<job>.<ext>          staging for the resize worker (served, short-lived)
 *
 * The flat `photos/<id>.<ext>` files next to the trail folders are the older
 * note / waypoint / area photos; nothing here touches them.
 */

export const PHOTOS_ROOT = 'photos';
export const SIDECAR_NAME = 'photos.json';
/**
 * The only photo folder the loopback server may serve: picked files are staged
 * here for the WebView worker and deleted right after. The copies themselves
 * are never served.
 */
export const PHOTO_INBOX = '.photo-inbox';

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Ids become path segments: refuse anything that could escape the folder. */
export function assertSafeId(id: string): string {
  if (!ID.test(id)) throw new Error(`Unsafe photo/trail id: ${JSON.stringify(id)}`);
  return id;
}

export function trailPhotoDir(trackId: string): string {
  return `${PHOTOS_ROOT}/${assertSafeId(trackId)}`;
}

export function sidecarPath(trackId: string): string {
  return `${trailPhotoDir(trackId)}/${SIDECAR_NAME}`;
}

export interface PhotoFilePaths {
  file: string;
  thumb: string;
  sprite: string;
}

export function photoFilePaths(trackId: string, photoId: string): PhotoFilePaths {
  const dir = trailPhotoDir(trackId);
  const id = assertSafeId(photoId);
  return {
    file: `${dir}/${id}.jpg`,
    thumb: `${dir}/${id}.sq.jpg`,
    sprite: `${dir}/${id}.map2.png`,
  };
}

/** The photo id a file in a trail folder belongs to, or null (the sidecar, strays). */
export function photoIdOfFile(name: string): string | null {
  const m = /^([A-Za-z0-9_-]{1,64})(?:\.sq\.jpg|\.map2?\.png|\.jpg)$/.exec(name);
  return m ? m[1]! : null;
}

/** Staging path for one resize job. */
export function inboxPath(jobId: string, ext = 'jpg'): string {
  const clean = /^[a-z0-9]{1,5}$/i.test(ext) ? ext.toLowerCase() : 'jpg';
  return `${PHOTO_INBOX}/${assertSafeId(jobId)}.${clean}`;
}

/**
 * Files in a trail folder that no live photo references — left by a crash
 * between writing the copies and saving the sidecar, or by a delete whose
 * file removal failed. Never lists the sidecar itself or its staging files.
 */
export function orphanFiles(
  fileNames: readonly string[],
  referencedIds: ReadonlySet<string>,
): string[] {
  return fileNames.filter((name) => {
    if (name === SIDECAR_NAME || name.startsWith(`${SIDECAR_NAME}.`)) return false;
    const id = photoIdOfFile(name);
    return id === null ? false : !referencedIds.has(id);
  });
}
