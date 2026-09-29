/**
 * The import job (#432/#435): one connected-source import at a time, its
 * progress counters, why it is paused, and what is left to fetch — persisted
 * (`imports.json`) so a job the OS killed, or one waiting out Strava's daily
 * limit, can be resumed. Pure: the store persists it, the importer drives it.
 */

import { isActivitySourceId } from './origin';
import type { ActivitySourceId, ImportPause, ImportRange } from './sources';

export type ImportJobStatus = 'running' | 'paused' | 'done' | 'stopped' | 'error';

/**
 * Why a job is paused:
 * - `daily-limit`: Strava's daily read budget is spent; resumes at `resumeAt`;
 * - `background`: a Health import left the foreground (Health reads only run
 *   in the foreground); resumes when the app comes back;
 * - `interrupted`: the app was closed mid-import; the user resumes it.
 */
export type ImportPausedReason = 'daily-limit' | 'background' | 'interrupted';

export interface ImportJob {
  source: ActivitySourceId;
  range: ImportRange;
  /** Epoch ms the listing starts at (the range, resolved when the job began). */
  since: number;
  /** Epoch ms the job began; becomes the source's "last import" when it finishes. */
  startedAt: number;
  status: ImportJobStatus;
  /** True until the listing is in and planned (`total` is known). */
  listing: boolean;
  /** New activities to fetch. */
  total: number;
  /** Of `total`, handled so far (imported, skipped or failed). */
  done: number;
  imported: number;
  /** Already in the Library (listed, or found once the route was fetched). */
  skippedDuplicates: number;
  /** No route to draw (indoor, manual, or an empty route). */
  noGps: number;
  failed: number;
  /** Totals of the imported trails, for the done card. */
  distanceM: number;
  ascentM: number;
  /** A rate-limit wait the running job is sitting out right now. */
  pause: ImportPause;
  pausedReason: ImportPausedReason | null;
  /** Epoch ms a `daily-limit` pause lifts. */
  resumeAt: number | null;
  /** Why the job stopped with an error ("reconnect", "no connection"). */
  message: string | null;
  /** `auth`: the fix is reconnecting the source in Settings. */
  errorKind: 'auth' | 'other' | null;
  /** External ids still to fetch (resume restricts the re-listing to these). */
  remaining: string[];
  /** Library ids of the trails this job imported (the done card's heatmap focus). */
  importedTrackIds: string[];
  /**
   * Started automatically (Strava auto-import): no card until there is
   * something to import, and a one-line message instead of the summary.
   */
  quiet: boolean;
}

/** A fresh job, listing. */
export function newImportJob(args: {
  source: ActivitySourceId;
  range: ImportRange;
  since: number;
  now: number;
  quiet?: boolean;
}): ImportJob {
  return {
    source: args.source,
    range: args.range,
    since: args.since,
    startedAt: args.now,
    status: 'running',
    listing: true,
    total: 0,
    done: 0,
    imported: 0,
    skippedDuplicates: 0,
    noGps: 0,
    failed: 0,
    distanceM: 0,
    ascentM: 0,
    pause: null,
    pausedReason: null,
    resumeAt: null,
    message: null,
    errorKind: null,
    remaining: [],
    importedTrackIds: [],
    quiet: args.quiet ?? false,
  };
}

/** Whether the job still has work it can pick up. */
export function isResumable(job: ImportJob): boolean {
  return job.status === 'paused' || job.status === 'stopped';
}

/** Fraction done, 0..1 (0 while listing). */
export function jobProgress(job: ImportJob): number {
  if (job.total <= 0) return 0;
  return Math.min(1, Math.max(0, job.done / job.total));
}

// --- persistence -------------------------------------------------------------

export const IMPORT_SCHEMA_VERSION = 1;

export interface ImportDoc {
  schemaVersion: number;
  job: ImportJob | null;
  /** Epoch ms of each source's last finished import ("Since last import"). */
  lastImportAt: Partial<Record<ActivitySourceId, number>>;
  /** The Health read permission was asked for and answered (not denied). */
  healthAllowed: boolean;
  /** Settings' "Import new activities automatically" for Strava (default on). */
  autoImportStrava: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function amount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function epoch(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function sanitizeRange(raw: unknown): ImportRange | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === 'everything') return { kind: 'everything' };
  if (raw.kind === 'since') {
    const after = epoch(raw.after);
    return after === null ? null : { kind: 'since', after };
  }
  if (raw.kind === 'last-days') {
    const days = count(raw.days);
    return days > 0 ? { kind: 'last-days', days } : null;
  }
  return null;
}

const STATUSES: readonly ImportJobStatus[] = ['running', 'paused', 'done', 'stopped', 'error'];
const REASONS: readonly ImportPausedReason[] = ['daily-limit', 'background', 'interrupted'];

/**
 * A persisted job, or null when junk. A job that was `running` when the app
 * died comes back `paused` (`interrupted`), and a `background` pause the app
 * never came back to does too: nothing is running after a cold start.
 */
export function sanitizeImportJob(raw: unknown): ImportJob | null {
  if (!isRecord(raw) || !isActivitySourceId(raw.source)) return null;
  const range = sanitizeRange(raw.range);
  if (!range) return null;
  const status = STATUSES.find((s) => s === raw.status);
  if (!status) return null;
  const reason = REASONS.find((r) => r === raw.pausedReason) ?? null;
  const total = count(raw.total);
  const job: ImportJob = {
    source: raw.source,
    range,
    since: epoch(raw.since) ?? 0,
    startedAt: epoch(raw.startedAt) ?? 0,
    status,
    listing: raw.listing === true,
    total,
    done: Math.min(total, count(raw.done)),
    imported: count(raw.imported),
    skippedDuplicates: count(raw.skippedDuplicates),
    noGps: count(raw.noGps),
    failed: count(raw.failed),
    distanceM: amount(raw.distanceM),
    ascentM: amount(raw.ascentM),
    pause: null,
    pausedReason: status === 'paused' ? reason : null,
    resumeAt: epoch(raw.resumeAt),
    message: typeof raw.message === 'string' ? raw.message : null,
    errorKind: raw.errorKind === 'auth' || raw.errorKind === 'other' ? raw.errorKind : null,
    remaining: strings(raw.remaining),
    importedTrackIds: strings(raw.importedTrackIds),
    quiet: raw.quiet === true,
  };
  if (job.status === 'running' || (job.status === 'paused' && job.pausedReason !== 'daily-limit')) {
    return { ...job, status: 'paused', pausedReason: 'interrupted' };
  }
  if (job.status === 'paused' && job.pausedReason === null) {
    return { ...job, pausedReason: 'interrupted' };
  }
  return job;
}

/** The whole `imports.json`, from anything (junk → defaults). Never throws. */
export function sanitizeImportDoc(raw: unknown): Omit<ImportDoc, 'schemaVersion'> {
  const doc = isRecord(raw) ? raw : {};
  const lastImportAt: Partial<Record<ActivitySourceId, number>> = {};
  if (isRecord(doc.lastImportAt)) {
    for (const [key, value] of Object.entries(doc.lastImportAt)) {
      const at = epoch(value);
      if (isActivitySourceId(key) && at !== null) lastImportAt[key] = at;
    }
  }
  return {
    job: sanitizeImportJob(doc.job),
    lastImportAt,
    healthAllowed: doc.healthAllowed === true,
    autoImportStrava: doc.autoImportStrava !== false,
  };
}
