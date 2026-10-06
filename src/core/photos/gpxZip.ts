import { buildGpx, parseGpx, type GpxDocument, type GpxWaypoint } from '@core/geo/gpx';

import { isNotePhoto, type TrackPhoto } from './model';
import { orderPhotos, visiblePhotos } from './stack';

/**
 * "Trail + photos" sharing (#587, owner Q8: GPX alone by default, a zip with
 * the photos when asked). The zip holds the trail's GPX with one `<wpt>` per
 * photo — plain GPX 1.1, so any app shows a waypoint per photo:
 *
 *   <wpt lat lon><time/><name>caption</name>
 *     <link href="photos/<id>.jpg"><type>image/jpeg</type></link>
 *     <type>photo</type></wpt>
 *
 * — plus each photo's display copy under `photos/`. That copy is either a
 * canvas re-encode (no metadata at all) or, with "Full size", the original
 * JPEG run through `stripJpegMetadata` (EXIF, XMP, IPTC, MPF, comments and
 * anything appended after the image, such as a Motion Photo's video, removed;
 * only the orientation and the ICC profile kept). Trail-note photos seen
 * through `noteToPhoto` are NOT included: they are the user's own files, never
 * stripped, and their `note:<id>` ids are not file names. So the archive
 * leaks no location beyond the waypoints the user chose to share. Opening the
 * zip in Inukshuk re-attaches each photo to its waypoint.
 */

/** GPX `<type>` marking a photo waypoint. */
export const PHOTO_WPT_TYPE = 'photo';
export const PHOTO_MIME = 'image/jpeg';
const ZIP_PHOTO_DIR = 'photos';

/** The archive path of a photo's copy. */
export function zipPhotoPath(photo: Pick<TrackPhoto, 'id'>): string {
  return `${ZIP_PHOTO_DIR}/${photo.id}.jpg`;
}

/**
 * The photos a "Trail + photos" archive carries: visible, in time order, and
 * never a trail-note photo (the user's own file, not a stripped copy).
 */
function sharedPhotos(photos: readonly TrackPhoto[]): TrackPhoto[] {
  return orderPhotos(visiblePhotos(photos)).filter((p) => !isNotePhoto(p));
}

/** One photo as a GPX waypoint, in the order of {@link orderPhotos}. */
export function photoWaypoints(photos: readonly TrackPhoto[]): GpxWaypoint[] {
  return sharedPhotos(photos).map((p, i) => {
    const name = p.caption?.trim() || `Photo ${i + 1}`;
    const wpt: GpxWaypoint = {
      latitude: p.lngLat[1],
      longitude: p.lngLat[0],
      name,
      type: PHOTO_WPT_TYPE,
      link: { href: zipPhotoPath(p), mimeType: PHOTO_MIME, text: name },
    };
    if (p.takenAt !== undefined) wpt.time = p.takenAt;
    return wpt;
  });
}

/**
 * The trail's GPX with its photo waypoints added. The original GPX is parsed
 * and rebuilt (points, segments, metadata and existing waypoints round-trip);
 * photo waypoints a previous export left in it are replaced, not duplicated.
 */
export function gpxWithPhotoWaypoints(gpxXml: string, photos: readonly TrackPhoto[]): string {
  const doc = parseGpx(gpxXml);
  const kept = doc.waypoints.filter((w) => w.type !== PHOTO_WPT_TYPE);
  const metadata = { ...doc.metadata };
  return buildGpx({
    points: doc.points,
    metadata,
    waypoints: [...kept, ...photoWaypoints(photos)],
    segmentStarts: doc.segmentStarts,
  });
}

export interface TrailZipEntry {
  zipPath: string;
  /** Document-relative path of the display copy. */
  sourcePath: string;
  photoId: string;
}

export interface TrailZipPlan {
  /** The zip's file name, e.g. `Mont du Lac des Cygnes.zip`. */
  zipName: string;
  /** The GPX entry's name inside the zip. */
  gpxName: string;
  /** Photo files to store (already-compressed JPEGs: stored, not deflated). */
  entries: TrailZipEntry[];
}

/** Plan a trail + photos archive. The GPX text is built separately ({@link gpxWithPhotoWaypoints}). */
export function planTrailPhotoZip(trackName: string, photos: readonly TrackPhoto[]): TrailZipPlan {
  const base = safeBaseName(trackName);
  return {
    zipName: `${base}.zip`,
    gpxName: `${base}.gpx`,
    entries: sharedPhotos(photos).map((p) => ({
      zipPath: zipPhotoPath(p),
      sourcePath: p.file,
      photoId: p.id,
    })),
  };
}

/**
 * A trail name as a file name the share sheet and every OS accept: path and
 * reserved characters become `-`, control characters go, spaces and accents
 * stay (it is shown to people), leading dots and a trailing .gpx/.zip are
 * stripped, and it is never empty.
 */
function safeBaseName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\.(gpx|zip)$/i, '')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 120);
  return cleaned === '' ? 'Trail' : cleaned;
}

/** A photo waypoint in an imported GPX matched to a file in the same zip. */
export interface LinkedPhoto {
  waypoint: GpxWaypoint;
  /** The zip entry name the link points to. */
  entryName: string;
}

const IMAGE_EXT = /\.(jpe?g|png|heic|heif|webp)$/i;

function normalizeHref(href: string): string {
  let h = href.trim();
  try {
    h = decodeURIComponent(h);
  } catch {
    // keep the raw form
  }
  return h.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase();
}

/**
 * Pair the photo waypoints of a GPX with the image entries of the zip it came
 * in. A waypoint counts when it links (relatively) to an image entry that
 * exists; remote URLs and missing files are ignored. Matching is
 * case-insensitive and tolerant of `./`, a leading `/`, backslashes and
 * percent-encoding.
 */
export function linkedPhotos(
  doc: Pick<GpxDocument, 'waypoints'>,
  entryNames: readonly string[],
): LinkedPhoto[] {
  const byNorm = new Map<string, string>();
  for (const name of entryNames) {
    if (IMAGE_EXT.test(name)) byNorm.set(normalizeHref(name), name);
  }
  const out: LinkedPhoto[] = [];
  for (const waypoint of doc.waypoints) {
    const href = waypoint.link?.href;
    if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
    const entryName = byNorm.get(normalizeHref(href));
    if (entryName) out.push({ waypoint, entryName });
  }
  return out;
}
