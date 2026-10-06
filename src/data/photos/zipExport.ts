import { strToU8, Zip, ZipDeflate, ZipPassThrough } from 'fflate';

import { gpxWithPhotoWaypoints, planTrailPhotoZip } from '@core/photos/gpxZip';
import type { TrackPhoto } from '@core/photos/model';
import {
  createCacheFileWriter,
  deleteFileAt,
  fileExists,
  readFileChunks,
  readFileText,
  type CacheFileWriter,
} from '@data/storage';

/**
 * Build the "Trail + photos" zip (#587, owner Q8) in the cache, ready for the
 * share sheet: the trail's GPX with a photo waypoint per photo, plus the
 * display copies (canvas re-encodes, or stripped "Full size" originals; see
 * `@core/photos/gpxZip`) under `photos/`. Trail-note photos are never included. Streamed like "Download your
 * data" — one 1 MB slice in memory at a time — and the copies are stored, not
 * deflated (JPEG doesn't compress). The caller shares `uri` and then deletes it.
 */

const CHUNK_BYTES = 1024 * 1024;

export interface TrailZip {
  uri: string;
  name: string;
  photos: number;
}

export async function writeTrailPhotoZip(args: {
  trackName: string;
  /** The trail's GPX (document-relative or absolute). */
  gpxUri: string;
  photos: readonly TrackPhoto[];
}): Promise<TrailZip> {
  const plan = planTrailPhotoZip(args.trackName, args.photos);
  const gpx = gpxWithPhotoWaypoints(await readFileText(args.gpxUri), args.photos);
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
      // A copy deleted since planning: skip it before writing a header.
      if (!fileExists(entry.sourcePath)) continue;
      const stream = new ZipPassThrough(entry.zipPath);
      zip.add(stream);
      readFileChunks(entry.sourcePath, CHUNK_BYTES, (chunk, final) => stream.push(chunk, final));
      check();
      photos++;
    }
    zip.end();
    check();
    writer.close();
    return { uri: writer.uri, name: plan.zipName, photos };
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
