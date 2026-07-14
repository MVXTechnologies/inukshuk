import { migrateErrorQueueDoc } from '@core/errors/queue';
import type { ErrorQueueDoc } from '@core/errors/types';
import * as storage from '@data/storage';

/**
 * Durable persistence for the error-report queue. Errors on an offline hike
 * must survive restarts until connectivity returns, so the queue lives in
 * `error-reports.json` at the document root (same atomic write path as the
 * library index and settings).
 */

const ERROR_QUEUE_FILE = 'error-reports.json';

/** Read + sanitize the persisted queue. Junk or absence yields an empty doc. */
export async function readErrorQueueDoc(): Promise<ErrorQueueDoc> {
  const raw = await storage.readJson<unknown>(ERROR_QUEUE_FILE);
  return migrateErrorQueueDoc(raw);
}

/**
 * Persist the queue. Synchronous on purpose: the caller may be a fatal-error
 * handler racing the crash dialog, and `storage.writeJson` completes the
 * atomic stage-and-swap before returning.
 */
export function writeErrorQueueDoc(doc: ErrorQueueDoc): void {
  storage.writeJson(ERROR_QUEUE_FILE, doc);
}
