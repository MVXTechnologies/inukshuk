import { strToU8, Zip, ZipDeflate, ZipPassThrough } from 'fflate';

import { gpxWithPhotoWaypoints, planTrailPhotoZip } from '@core/photos/gpxZip';
import type { TrackPhoto } from '@core/photos/model';
import { shareableJpeg } from '@core/photos/shareable';
import {
  createCacheFileWriter,
  deleteFileAt,
  fileExists,
  readFileBytes,
  readFileText,
  type CacheFileWriter,
} from '@data/storage';

/**
 * Build the "Trail + photos" zip (#587, owner Q8) in the cache, ready for the
 * share sheet: the trail's GPX with a photo waypoint per photo, plus the
 * display copies under `photos/`. Trail-note photos are never included (see
 * `@core/photos/gpxZip`). The copies are stored, not deflated (JPEG doesn't
 * compress), one photo in memory at a time. The caller shares `uri` and then
 * deletes it.
 *
 * Every copy is checked on the way out (`shareableJpeg`): one that still
 * carries metadata is stripped in the archive, and one that cannot be parsed
 * is left out along with its waypoint — a file whose metadata cannot be
 * checked never leaves the phone.
 */

export interface TrailZip {
  uri: string;
  name: string;
  /** Photos in the archive. */
  photos: number;
  /** Copies left out: deleted since planning, or not a JPEG that could be checked. */
  skipped: number;
}

export async function writeTrailPhotoZip(args: {
  trackName: string;
  /** The trail's GPX (document-relative or absolute). */
  gpxUri: string;
  photos: readonly TrackPhoto[];
}): Promise<TrailZip> {
  const planned = planTrailPhotoZip(args.trackName, args.photos);
  // First pass: which copies can go (exists, and is a JPEG whose metadata we can check).
  const shareable = new Set<string>();
  for (const entry of planned.entries) {
    if (!fileExists(entry.sourcePath)) continue;
    if (shareableJpeg(await readFileBytes(entry.sourcePath)).kind !== 'unreadable') {
      shareable.add(entry.photoId);
    }
  }
  const kept = args.photos.filter((p) => shareable.has(p.id));
  const plan = planTrailPhotoZip(args.trackName, kept);
  const gpx = gpxWithPhotoWaypoints(await readFileText(args.gpxUri), kept);
  let writer: CacheFileWriter | null = null;
  try {
    writer = createCacheFileWriter(plan.zipName);
    const sink = writer;
    let zipError: Error | null = null;
    const zip = new Zip((err, chunk) => {
      if (err) {
        zipError ??= err;
        return;
      }
      if (chunk.length > 0) sink.write(chunk);
    });
    const check = () => {
      if (zipError) throw zipError;
    };
    const gpxEntry = new ZipDeflate(plan.gpxName, { level: 6 });
    zip.add(gpxEntry);
    gpxEntry.push(strToU8(gpx), true);
    check();
    let photos = 0;
    for (const entry of plan.entries) {
      const bytes = await readFileBytes(entry.sourcePath);
      const checked = shareableJpeg(bytes);
      // Checked in the first pass; a file swapped since then is not trusted.
      if (checked.kind === 'unreadable') throw new Error('a photo changed while zipping');
      const stream = new ZipPassThrough(entry.zipPath);
      zip.add(stream);
      stream.push(checked.kind === 'stripped' ? checked.bytes : bytes, true);
      check();
      photos++;
    }
    zip.end();
    check();
    writer.close();
    return {
      uri: writer.uri,
      name: plan.zipName,
      photos,
      skipped: planned.entries.length - photos,
    };
  } catch (err) {
    if (writer) {
      try {
        writer.close();
        deleteFileAt(writer.uri);
      } catch {
        // best effort: never leave a half-written archive
      }
    }
    throw err;
  }
}
