import {
  DEFAULT_IMPORT_LIMITS,
  DuplicateIndex,
  ImportLimitError,
  activityGpxText,
  activityTrackName,
  categoryForSport,
  decodeActivityFile,
  sniffActivityFormat,
  walkActivityArchive,
  type ArchiveHost,
  type DecodedActivity,
} from '@core/geo/activityFiles';
import { buildImportedTrack, snapWaypointsToNotes } from '@core/geo/track';
import { sniffOpenedFile, type OpenedFileFormat } from '@core/import/openedFile';
import { ByteBudget } from '@core/geo/activityFiles/limits';
import { listZipEntries } from '@core/geo/activityFiles/zip';
import type { TrackPoint, TrackSummary } from '@core/models';
import { photoCountLabel } from '@core/photos/summary';
import {
  planZipPhotoAttach,
  waypointsForNotes,
  type ZipEntryInfo,
  type ZipPhotoAttach,
} from '@core/photos/zipImport';
import { attachZipPhotos } from '@features/photos/attachZipPhotos';
import { photoResizer } from '@features/photos/photoResizer';
import * as storage from '@data/storage';
import { primeTrackGeometry } from '@data/trackGeometry';
import { primeTrailStats } from '@data/trailStatsStore';
import { reportError } from '@lib/errorReporting';
import * as DocumentPicker from 'expo-document-picker';

import type { ImportedTrack } from './importGpx';

/**
 * Import activities from Strava / Garmin export FILES — no accounts, no
 * network: FIT, TCX, GPX (each optionally gzipped) and zip archives of them
 * (Strava bulk export, Garmin bulk export with its nested zips). Every
 * activity lands as a GPX track through the same `buildImportedTrack` →
 * `writeTrackGpx` pipeline as a plain GPX import. All format logic is in
 * `@core/geo/activityFiles`; this module is the file-system shell around it.
 */

export interface ActivityImportSummary {
  /**
   * Imported trails, ready for `libraryStore.addTracks`. Their `track.points`
   * are released (empty) — the GPX on disk holds them and the library summary
   * never reads them — so a 2 000-activity archive doesn't keep every point
   * in memory until the import ends.
   */
  items: ImportedTrack[];
  /** Activities skipped because the library (or this import) already has them. */
  duplicates: number;
  /** Files/entries that could not be read. */
  failed: number;
  /** A size/entry cap stopped an archive early. */
  limitReached: boolean;
  /** Photos re-attached from "Trail + photos" zips (#587). */
  photos: number;
  /** Photos in such zips that could not be attached (too big, too many, unreadable). */
  photosFailed: number;
}

export type BulkActivityImportResult =
  | ({ kind: 'imported' } & ActivityImportSummary)
  | { kind: 'canceled' }
  | { kind: 'error'; message: string };

/** Called as an archive is walked: activities handled so far, and discovered. */
export type ImportProgress = (done: number, total: number) => void;

/** Picker filter: accept broadly (MIME types for FIT/TCX vary wildly) and sniff content. */
const PICKER_TYPES = [
  'application/gpx+xml',
  'application/vnd.garmin.tcx+xml',
  'application/vnd.ant.fit',
  'application/zip',
  'application/gzip',
  'application/xml',
  'text/xml',
  'application/octet-stream',
  '*/*',
];

/**
 * Hand the JS thread back to the UI regularly: `yieldToUi` is awaited between
 * every entry and slice, but only actually waits a macrotask once ~24 ms of
 * work has piled up, so small entries don't pay a timer each.
 */
function createYielder(budgetMs = 24): () => Promise<void> {
  let last = Date.now();
  return async () => {
    if (Date.now() - last < budgetMs) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    last = Date.now();
  };
}

function fileHost(yieldToUi: () => Promise<void>): ArchiveHost {
  return {
    open: (ref, fn) => storage.withFileByteSource(ref, fn),
    createSpill: () => {
      const writer = storage.createImportSpillWriter(`${storage.newId()}.zip`);
      return { ref: writer.uri, write: writer.write, close: writer.close };
    },
    discardSpill: (ref) => {
      try {
        storage.deleteFileAt(ref);
      } catch {
        // A leftover cache file is harmless; the OS clears the cache.
      }
    },
    yieldToUi,
  };
}

const isTimed = (a: DecodedActivity): boolean =>
  a.points.some((p) => p.hasTime !== false && Number.isFinite(p.time) && p.time > 0);

/** Shared state for one import session (one pick, or one "Open with"). */
class ImportSession {
  readonly items: ImportedTrack[] = [];
  duplicates = 0;
  failed = 0;
  limitReached = false;
  /** Trail photos re-attached from "Trail + photos" zips (#587), and those that failed. */
  photos = 0;
  photosFailed = 0;
  /**
   * While a zip is walked: its top-level entries, so a GPX in it whose photo
   * waypoints link to `photos/…` entries gets those photos back.
   */
  zipEntries: ZipEntryInfo[] | null = null;
  readonly pendingPhotos: { trackId: string; points: TrackPoint[]; attach: ZipPhotoAttach[] }[] =
    [];
  private readonly index: DuplicateIndex;
  readonly yieldToUi = createYielder();

  constructor(existing: readonly TrackSummary[]) {
    this.index = new DuplicateIndex(
      existing.map((t) => ({ startedAt: t.startedAt, distanceM: t.stats.distanceM })),
    );
  }

  /** Build, dedupe and persist one decoded activity. */
  add(activity: DecodedActivity): void {
    const name = activityTrackName({
      name: activity.name,
      sport: activity.sport,
      startTime: activity.startTime,
      fileName: activity.sourceName,
    });
    const id = storage.newId();
    const category = categoryForSport(activity.sport);
    const track = buildImportedTrack({
      id,
      points: activity.points,
      segmentStarts: activity.segmentStarts,
      name,
      fallbackName: name,
      fallbackTime: Date.now(),
      category,
    });
    const timed = isTimed(activity);
    if (timed) {
      const fingerprint = { startedAt: track.startedAt, distanceM: track.stats.distanceM };
      if (this.index.has(fingerprint)) {
        this.duplicates += 1;
        return;
      }
      this.index.add(fingerprint);
    }
    if (category) track.category = category;
    // Same rule as a GPX import: an untimed file is a route to follow.
    else if (!timed) track.category = 'navigation';

    const fileUri = storage.writeTrackGpx(id, activityGpxText(activity, track.name));
    let waypoints = activity.waypoints ?? [];
    // A "Trail + photos" zip (#587): its photo waypoints are photos, not notes.
    if (
      activity.format === 'gpx' &&
      this.zipEntries?.some((e) => e.name === activity.sourceName) === true
    ) {
      const photoPlan = planZipPhotoAttach(waypoints, this.zipEntries);
      waypoints = waypointsForNotes(waypoints, photoPlan.photoWaypoints);
      this.photosFailed += photoPlan.tooBig + photoPlan.overCount;
      if (photoPlan.attach.length > 0) {
        this.pendingPhotos.push({ trackId: id, points: activity.points, attach: photoPlan.attach });
      }
    }
    const notes =
      activity.format === 'gpx' && activity.hasTrackOrRoutePoints
        ? snapWaypointsToNotes(activity.points, waypoints, activity.segmentStarts)
        : [];
    // Draw it from the points in hand: the map and Library never have to
    // parse this GPX back (#465).
    primeTrackGeometry(track, activity.points, activity.segmentStarts);
    if (timed) primeTrailStats(track, activity.points, activity.segmentStarts);
    this.items.push({ track: { ...track, points: [] }, fileUri, notes });
  }

  summary(): ActivityImportSummary {
    return {
      items: this.items,
      duplicates: this.duplicates,
      failed: this.failed,
      limitReached: this.limitReached,
      photos: this.photos,
      photosFailed: this.photosFailed,
    };
  }
}

/**
 * Re-attach the photos of "Trail + photos" zips (#587) to the trails just
 * imported from them, while the archive is still open. A failure costs only
 * the photos: the trails are already imported.
 */
async function attachPendingPhotos(
  session: ImportSession,
  zipRef: string,
  host: ArchiveHost,
  budget: ByteBudget,
): Promise<void> {
  for (const pending of session.pendingPhotos) {
    try {
      const result = await attachZipPhotos({
        trackId: pending.trackId,
        points: pending.points,
        attach: pending.attach,
        zipRef,
        host,
        budget,
        resizer: photoResizer,
        newId: storage.newId,
      });
      session.photos += result.added;
      session.photosFailed += result.failed;
    } catch (err) {
      reportError(err, 'zip-photo-import');
      session.photosFailed += pending.attach.length;
    }
  }
}

/**
 * Import every activity in one file (loose or archive). Per-activity failures
 * are counted on the session; only a failure to read the file at all throws.
 */
async function importFile(
  session: ImportSession,
  uri: string,
  displayName: string,
  onProgress?: ImportProgress,
): Promise<void> {
  const head = storage.readFileHead(uri, 4096);
  const format = sniffActivityFormat(head, displayName);
  if (format === 'zip') {
    const host = fileHost(session.yieldToUi);
    // One decompression budget for the walk AND the photos read afterwards.
    const budget = new ByteBudget(DEFAULT_IMPORT_LIMITS.maxTotalBytes);
    try {
      session.zipEntries = host
        .open(uri, (src) => listZipEntries(src))
        .map((e) => ({ name: e.name, uncompressedSize: e.uncompressedSize }));
    } catch {
      session.zipEntries = null; // the walk below reports an unreadable archive
    }
    try {
      const result = await walkActivityArchive(uri, host, (activity) => session.add(activity), {
        onProgress: onProgress && ((p) => onProgress(p.processed, p.discovered)),
        onEntryError: (err, entry) => reportError(err, `activity-import:${entry}`),
        budget,
      });
      session.failed += result.failed;
      session.limitReached ||= result.limitReached;
      await attachPendingPhotos(session, uri, host, budget);
    } finally {
      session.zipEntries = null;
      session.pendingPhotos.length = 0;
    }
    return;
  }
  if (storage.fileSizeAt(uri) > DEFAULT_IMPORT_LIMITS.maxEntryBytes) {
    throw new ImportLimitError(`${displayName} is larger than the per-file limit`);
  }
  const bytes = await storage.readFileBytes(uri);
  for (const activity of decodeActivityFile(bytes, displayName)) session.add(activity);
}

/**
 * Let the user pick activity files / export archives and import them all.
 * `existing` is the library's tracks, for duplicate detection.
 */
export async function pickAndImportActivityFiles(
  existing: readonly TrackSummary[],
  onProgress?: ImportProgress,
): Promise<BulkActivityImportResult> {
  let picked: DocumentPicker.DocumentPickerResult;
  try {
    picked = await DocumentPicker.getDocumentAsync({
      type: PICKER_TYPES,
      copyToCacheDirectory: true,
      multiple: true,
    });
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : 'Picker failed' };
  }
  if (picked.canceled || picked.assets.length === 0) return { kind: 'canceled' };

  const session = new ImportSession(existing);
  for (const asset of picked.assets) {
    try {
      await importFile(session, asset.uri, asset.name ?? 'Imported activity', onProgress);
    } catch (err) {
      reportError(err, 'activity-import');
      session.failed += 1;
    } finally {
      // The picker's cache copy of a multi-GB export shouldn't outlive the import.
      if (storage.isCacheUri(asset.uri)) {
        try {
          storage.deleteFileAt(asset.uri);
        } catch {
          // Cache; the OS reclaims it eventually.
        }
      }
    }
  }
  return { kind: 'imported', ...session.summary() };
}

/** An "Open with" uri, sniffed and made readable for random access. */
export interface OpenedImport {
  /** Uri to read from: the original, or a cache copy when it can't be opened in place. */
  uri: string;
  /** A PDF is a map (#246); anything else an activity file, or `unknown`. */
  format: OpenedFileFormat;
  /** Remove the cache copy, if one was made. Never throws. */
  dispose: () => void;
}

/**
 * Sniff an opened uri's format from its first bytes — `content://` uris often
 * carry no file name. When the platform can't open it for random access, it
 * is copied into the cache first. A uri that can't be read either way comes
 * back as `unknown`, for the caller's plain-GPX path to try (and report).
 */
export async function openImportedUri(uri: string): Promise<OpenedImport> {
  const noop = () => {};
  try {
    const head = storage.readFileHead(uri, 4096);
    // An empty head means the provider reported no size to the handle
    // (some content:// providers): copy it to find out what it is.
    if (head.length > 0) return { uri, format: sniffOpenedFile(head, uri), dispose: noop };
  } catch {
    // Fall through to a cache copy.
  }
  let local: string;
  try {
    local = await storage.copyToImportCache(uri, `${storage.newId()}.import`);
  } catch {
    return { uri, format: 'unknown', dispose: noop };
  }
  const dispose = () => {
    try {
      storage.deleteFileAt(local);
    } catch {
      // Cache; the OS reclaims it eventually.
    }
  };
  try {
    return {
      uri: local,
      format: sniffOpenedFile(storage.readFileHead(local, 4096), uri),
      dispose,
    };
  } catch {
    dispose();
    return { uri, format: 'unknown', dispose: noop };
  }
}

/**
 * Import every activity in an opened FIT / TCX / gzip / zip file (see
 * {@link openImportedUri}). Throws when the file can't be read at all.
 */
export async function importActivitiesFromUri(
  uri: string,
  displayName: string,
  existing: readonly TrackSummary[],
  onProgress?: ImportProgress,
): Promise<ActivityImportSummary> {
  const session = new ImportSession(existing);
  await importFile(session, uri, displayName, onProgress);
  return session.summary();
}

/** "Imported 214 trails · 3 duplicates skipped · 1 failed". */
export function activityImportMessage(summary: ActivityImportSummary): string {
  const n = summary.items.length;
  const parts = [
    `Imported ${n} trail${n === 1 ? '' : 's'}${
      summary.photos > 0 ? ` with ${photoCountLabel(summary.photos)}` : ''
    }`,
  ];
  if (summary.duplicates > 0) {
    parts.push(`${summary.duplicates} duplicate${summary.duplicates === 1 ? '' : 's'} skipped`);
  }
  if (summary.failed > 0) parts.push(`${summary.failed} failed`);
  if (summary.photosFailed > 0) {
    parts.push(`${photoCountLabel(summary.photosFailed)} not added`);
  }
  if (summary.limitReached) parts.push('stopped at the size limit');
  return parts.join(' · ');
}
