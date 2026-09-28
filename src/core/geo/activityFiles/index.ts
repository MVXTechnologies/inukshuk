/**
 * Activity-file import (Strava / Garmin exports): FIT, TCX and GPX files,
 * gzipped or not, loose or inside (nested) zip archives. Pure — all file I/O
 * is supplied by the caller. See `archive.ts` for the walk and `limits.ts` for
 * the zip-bomb caps.
 */
export {
  ActivityDecodeError,
  activityGpxText,
  decodeActivityFile,
  sniffActivityFormat,
  type ActivityFileFormat,
  type DecodedActivity,
} from './decode';
export {
  memoryArchiveHost,
  walkActivityArchive,
  type ArchiveHost,
  type ArchiveSpill,
  type WalkProgress,
  type WalkResult,
} from './archive';
export { DuplicateIndex, isSameActivity, type ActivityFingerprint } from './dedupe';
export {
  DEFAULT_IMPORT_LIMITS,
  ImportLimitError,
  looksLikeGzip,
  type ImportLimits,
} from './limits';
export { activityTrackName, categoryForSport, stravaTypeToSport } from './naming';
export { looksLikeZip } from './zip';
