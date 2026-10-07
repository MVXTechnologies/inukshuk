import type { TrailPhotoFiles } from '@core/export/archivePlan';
import { sidecarPath, trailPhotoDir } from '@core/photos/paths';
import { fileExists, resolveDocumentPath } from '@data/storage';

import { listTrailPhotoFiles, trailsWithPhotos } from './photoFiles';

/**
 * Trail photos for "Download your data" (#587): per trail, its display copies
 * (`<id>.jpg`; thumbs and map sprites are derived and left out) and its photo
 * list file as it is on disk. The list is NOT parsed: a backup must also carry
 * a list written by a newer app version, or one this version cannot read.
 * Only trails still in the library are included.
 */
export function trailPhotoFilesForArchive(
  trackIds: ReadonlySet<string>,
): Map<string, TrailPhotoFiles> {
  const out = new Map<string, TrailPhotoFiles>();
  for (const trackId of trailsWithPhotos()) {
    if (!trackIds.has(trackId)) continue;
    const dir = trailPhotoDir(trackId);
    const photos = listTrailPhotoFiles(trackId)
      .filter((name) => /^[A-Za-z0-9_-]{1,64}\.jpg$/.test(name))
      .sort()
      .map((name) => ({ id: name.slice(0, -4), file: resolveDocumentPath(`${dir}/${name}`) }));
    if (photos.length === 0) continue;
    const list = sidecarPath(trackId);
    const entry: TrailPhotoFiles = { photos };
    if (fileExists(list)) entry.listUri = resolveDocumentPath(list);
    out.set(trackId, entry);
  }
  return out;
}
