import { strFromU8 } from 'fflate';

import { decodeFit, looksLikeFit } from '@core/geo/fit';
import { buildGpx, parseGpx, type GpxWaypoint } from '@core/geo/gpx';
import { looksLikeTcx, parseTcx } from '@core/geo/tcx';
import type { TrackPoint } from '@core/models';

import { DEFAULT_IMPORT_LIMITS, gunzipBounded, looksLikeGzip, type ByteBudget } from './limits';
import { stravaTypeToSport } from './naming';
import { looksLikeZip } from './zip';

export type ActivityFileFormat = 'fit' | 'tcx' | 'gpx' | 'gzip' | 'zip' | 'unknown';

/** One activity decoded from a FIT/TCX/GPX file (possibly out of an archive). */
export interface DecodedActivity {
  format: 'fit' | 'tcx' | 'gpx';
  /** File name or archive path it came from. */
  sourceName: string;
  /** Explicit name (GPX/TCX metadata, Strava CSV); absent = derive one. */
  name?: string;
  /** Epoch ms of the activity start, when the file states it. */
  startTime?: number;
  /** Normalized sport key (see `naming.ts`). */
  sport?: string;
  points: TrackPoint[];
  segmentStarts: number[];
  /** GPX only: the original document, stored verbatim (keeps extensions). */
  gpxText?: string;
  /** GPX only: standalone `<wpt>`s, snapped to notes on import. */
  waypoints?: GpxWaypoint[];
  /** GPX only: false when `points` came from the `<wpt>` fallback. */
  hasTrackOrRoutePoints?: boolean;
}

export class ActivityDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActivityDecodeError';
  }
}

/**
 * Classify a file by content — content:// URIs often have no extension — with
 * the name's extension as a last resort. Magic bytes: FIT ".FIT" at offset 8,
 * gzip 1F 8B, zip "PK\3\4"; XML by its root element.
 */
export function sniffActivityFormat(bytes: Uint8Array, name?: string): ActivityFileFormat {
  if (looksLikeFit(bytes)) return 'fit';
  if (looksLikeGzip(bytes)) return 'gzip';
  if (looksLikeZip(bytes)) return 'zip';
  const head = strFromU8(bytes.subarray(0, 4096), true);
  if (looksLikeTcx(head)) return 'tcx';
  if (/<([A-Za-z0-9_]+:)?gpx[\s>]/.test(head)) return 'gpx';
  const ext = /\.([a-z0-9]+)$/i.exec(name ?? '')?.[1]?.toLowerCase();
  if (ext === 'fit' || ext === 'tcx' || ext === 'gpx' || ext === 'zip') return ext;
  if (ext === 'gz') return 'gzip';
  return 'unknown';
}

/** `<type>` of the first track (Strava/Garmin GPX exports set it), as a sport key. */
function gpxSport(text: string): string | undefined {
  const m = /<trk>[\s\S]{0,2000}?<type>\s*([^<]+?)\s*<\/type>/.exec(text.slice(0, 16384));
  const raw = m?.[1]?.toLowerCase();
  if (!raw) return undefined;
  if (raw === 'biking') return 'cycling';
  return stravaTypeToSport(raw);
}

/**
 * Decode one activity file (FIT, TCX, GPX, or any of them gzipped). Archives
 * are not handled here — see `walkActivityArchive`. Throws on anything that
 * isn't a supported activity or has no positioned points.
 */
export function decodeActivityFile(
  bytes: Uint8Array,
  sourceName: string,
  opts: { maxBytes?: number; budget?: ByteBudget } = {},
): DecodedActivity[] {
  const maxBytes = opts.maxBytes ?? DEFAULT_IMPORT_LIMITS.maxEntryBytes;
  let data = bytes;
  let format = sniffActivityFormat(data, sourceName);
  if (format === 'gzip') {
    data = gunzipBounded(data, maxBytes, opts.budget);
    format = sniffActivityFormat(data, sourceName.replace(/\.gz$/i, ''));
    if (format === 'gzip') throw new ActivityDecodeError('nested gzip is not supported');
  }

  let out: DecodedActivity[];
  switch (format) {
    case 'fit': {
      const fit = decodeFit(data);
      out = [{ format: 'fit', sourceName, ...fit }];
      break;
    }
    case 'tcx':
      out = parseTcx(strFromU8(data)).map((a) => ({ format: 'tcx' as const, sourceName, ...a }));
      break;
    case 'gpx': {
      const gpxText = strFromU8(data);
      const doc = parseGpx(gpxText);
      const activity: DecodedActivity = {
        format: 'gpx',
        sourceName,
        points: doc.points,
        segmentStarts: doc.segmentStarts,
        gpxText,
        waypoints: doc.waypoints,
        hasTrackOrRoutePoints: doc.hasTrackOrRoutePoints,
      };
      if (doc.metadata.name !== undefined) activity.name = doc.metadata.name;
      const sport = gpxSport(gpxText);
      if (sport !== undefined) activity.sport = sport;
      out = [activity];
      break;
    }
    case 'zip':
      throw new ActivityDecodeError('archives must be walked, not decoded');
    default:
      throw new ActivityDecodeError('not a FIT, TCX or GPX file');
  }
  const withPoints = out.filter((a) => a.points.length > 0);
  if (withPoints.length === 0) throw new ActivityDecodeError('No track points');
  return withPoints;
}

/** The GPX to store for an activity: the original for GPX, a serialization otherwise. */
export function activityGpxText(activity: DecodedActivity, name: string): string {
  if (activity.gpxText !== undefined) return activity.gpxText;
  return buildGpx({
    points: activity.points,
    segmentStarts: activity.segmentStarts,
    metadata: {
      name,
      ...(activity.startTime !== undefined ? { time: activity.startTime } : {}),
    },
  });
}
