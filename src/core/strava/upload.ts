/**
 * Pure upload logic for pushing a saved GPX to Strava: multipart field
 * building, total classification of the upload-status responses, and the
 * polling schedule. The fetch/FormData half lives in `src/lib/strava.ts`.
 *
 * Strava's upload flow is asynchronous: POST /api/v3/uploads returns an upload
 * id whose `status`/`error`/`activity_id` fields evolve as the file is
 * processed, so the client polls GET /api/v3/uploads/{id} briefly.
 */

/** Form fields accompanying the GPX file part in the upload POST. */
export function buildUploadFields(trailName: string, trackId: string): Record<string, string> {
  return {
    name: trailName,
    data_type: 'gpx',
    // Stable per-track id: re-pushing the same trail is recognizable on
    // Strava's side, and their duplicate detection has an anchor.
    external_id: `inukshuk-${trackId}`,
  };
}

/** Where an upload stands, as told by POST /uploads or GET /uploads/{id}. */
export type UploadStatus =
  | { kind: 'processing'; uploadId: number }
  | { kind: 'ready'; activityId: number | null }
  | { kind: 'duplicate' }
  | { kind: 'error'; message: string };

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;

/**
 * Totally classify an upload response body. Strava signals outcomes through a
 * combination of fields: a non-null `error` string means failure (duplicates
 * are reported as an error mentioning "duplicate"), a non-null `activity_id`
 * means the activity exists, and otherwise the upload is still processing
 * under `id`. Junk input classifies as an error, never throws.
 */
export function classifyUploadResponse(json: unknown): UploadStatus {
  const body = asRecord(json);
  if (!body) return { kind: 'error', message: 'Unexpected response from Strava' };

  const error = typeof body.error === 'string' && body.error !== '' ? body.error : null;
  if (error !== null) {
    if (/duplicate/i.test(error)) return { kind: 'duplicate' };
    return { kind: 'error', message: error };
  }

  const activityId = typeof body.activity_id === 'number' ? body.activity_id : null;
  if (activityId !== null) return { kind: 'ready', activityId };

  // Some responses only carry the human status line once processing finishes.
  const status = typeof body.status === 'string' ? body.status : '';
  if (/ready/i.test(status)) return { kind: 'ready', activityId: null };
  if (/deleted/i.test(status)) return { kind: 'error', message: 'Activity was deleted on Strava' };

  const uploadId = typeof body.id === 'number' && Number.isFinite(body.id) ? body.id : null;
  if (uploadId === null) return { kind: 'error', message: 'Unexpected response from Strava' };
  return { kind: 'processing', uploadId };
}

/**
 * Delays between status polls, in ms. Strava says most uploads settle within
 * ~8 s; this schedule waits ~16 s total, then the caller reports the upload as
 * accepted-but-still-processing rather than failed.
 */
export const UPLOAD_POLL_SCHEDULE_MS: readonly number[] = [1500, 2000, 2500, 3000, 3000, 4000];

/** Delay before poll attempt `attempt` (0-based), or null to stop polling. */
export function nextPollDelayMs(attempt: number): number | null {
  return UPLOAD_POLL_SCHEDULE_MS[attempt] ?? null;
}

/** Final outcome of an upload, after polling (or giving up on) processing. */
export type UploadOutcome =
  | { kind: 'ready' }
  | { kind: 'duplicate' }
  | { kind: 'timeout' }
  | { kind: 'error'; message: string };

/** One-line user-facing copy for an upload outcome (shown in a snackbar). */
export function describeUploadOutcome(outcome: UploadOutcome, trailName: string): string {
  switch (outcome.kind) {
    case 'ready':
      return `Pushed "${trailName}" to Strava`;
    case 'duplicate':
      return 'Strava already has this activity';
    case 'timeout':
      return 'Sent to Strava — still processing there';
    case 'error':
      return `Strava upload failed: ${outcome.message}`;
  }
}
