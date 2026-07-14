import { errorMarker, fingerprintError } from '@core/errors/fingerprint';
import {
  buildIssueBody,
  buildIssueTitle,
  buildManualReportUrl,
  buildSeenAgainComment,
} from '@core/errors/issueFormat';
import { canSendReport, emptyQueueDoc, mergeReport, pruneSentHistory } from '@core/errors/queue';
import type { ErrorEnvironment, ErrorQueueDoc, ErrorReport } from '@core/errors/types';
import { readErrorQueueDoc, writeErrorQueueDoc } from '@data/errorQueue';
import { useErrorPromptStore } from '@state/errorPromptStore';
import { useSettingsStore } from '@state/settingsStore';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { AppState, Platform } from 'react-native';
import type { ErrorUtils as ErrorUtilsType } from 'react-native';
import { addIssueComment, createIssue, findOpenIssueByMarker } from './github';

/**
 * "No silent fails": the runtime half of the error-reporting pipeline.
 *
 * Capture (global JS handler, unhandled rejections, error boundary, explicit
 * `reportError` calls) → durable on-disk queue (errors on an offline hike must
 * survive restarts) → delivery to GitHub issues, deduped by fingerprint and
 * rate-limited client-side. Without an API token, falls back to asking the
 * user to open a pre-filled `issues/new` URL.
 *
 * There is no connectivity listener on purpose (no netinfo native dependency —
 * this feature must stay OTA-able): the queue is flushed on launch, whenever
 * the app returns to the foreground, and after each capture; a flush that
 * fails offline simply leaves the queue for the next attempt.
 */

/** Issues repo receiving the reports. */
export const ERROR_REPORT_REPO = 'marcandrevigneault/inukshuk';

const MAX_BREADCRUMBS = 20;

// --- runtime access to RN globals -------------------------------------------

interface HermesInternalType {
  enablePromiseRejectionTracker?: (options: {
    allRejections: boolean;
    onUnhandled?: (id: number, rejection: unknown) => void;
    onHandled?: (id: number) => void;
  }) => void;
}

declare const global: {
  ErrorUtils?: ErrorUtilsType;
  HermesInternal?: HermesInternalType | null;
};

// --- configuration -----------------------------------------------------------

function reportingEnabled(): boolean {
  return useSettingsStore.getState().errorReporting;
}

function reportToken(): string | undefined {
  const token: unknown = Constants.expoConfig?.extra?.errorReportToken;
  return typeof token === 'string' && token !== '' ? token : undefined;
}

// --- environment snapshot ------------------------------------------------------

function buildEnvironment(): ErrorEnvironment {
  const constants = Platform.constants as Record<string, unknown>;
  const model = typeof constants.Model === 'string' ? constants.Model : undefined;
  return {
    appVersion: Constants.expoConfig?.version ?? 'unknown',
    ...(typeof Updates.runtimeVersion === 'string' && Updates.runtimeVersion !== ''
      ? { runtimeVersion: Updates.runtimeVersion }
      : {}),
    ...(typeof Updates.updateId === 'string' && Updates.updateId !== ''
      ? { updateId: Updates.updateId }
      : {}),
    os: `${Platform.OS} ${String(Platform.Version)}`,
    ...(model !== undefined ? { model } : {}),
  };
}

// --- breadcrumbs --------------------------------------------------------------

const breadcrumbs: string[] = [];

/** Record a short note about what the user/app just did (ring buffer of 20). */
export function addBreadcrumb(message: string): void {
  breadcrumbs.push(`${new Date().toISOString()} ${message}`);
  if (breadcrumbs.length > MAX_BREADCRUMBS) breadcrumbs.shift();
}

// --- durable queue (in-memory mirror of error-reports.json) --------------------

let doc: ErrorQueueDoc | null = null;
let docLoad: Promise<ErrorQueueDoc> | null = null;
/** Captures that raced the initial disk read; merged in once it completes. */
const preloadCaptures: ErrorReport[] = [];

function persistDoc(): void {
  if (doc) writeErrorQueueDoc(doc);
}

async function loadDoc(): Promise<ErrorQueueDoc> {
  if (doc) return doc;
  docLoad ??= (async () => {
    let loaded: ErrorQueueDoc;
    try {
      loaded = await readErrorQueueDoc();
    } catch {
      loaded = emptyQueueDoc();
    }
    doc = loaded;
    if (preloadCaptures.length > 0) {
      for (const report of preloadCaptures) doc.queue = mergeReport(doc.queue, report);
      preloadCaptures.length = 0;
      persistDoc();
    }
    return doc;
  })();
  return docLoad;
}

// --- capture -------------------------------------------------------------------

export interface CaptureOptions {
  /** Where the error was captured, e.g. `gpx-import`. */
  context?: string;
  /** React component stack, when caught by the error boundary. */
  componentStack?: string;
  /** True when the error crashed (or would have crashed) the app. */
  isFatal?: boolean;
}

function toMessageAndStack(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: `${error.name}: ${error.message}`,
      ...(typeof error.stack === 'string' ? { stack: error.stack } : {}),
    };
  }
  return { message: String(error) };
}

/**
 * Report an error into the durable queue (and trigger a delivery attempt).
 * Never throws — safe to call from catch blocks and crash handlers. This is
 * the one entry point the rest of the app should use.
 */
export function reportError(error: unknown, context?: string, options?: CaptureOptions): void {
  console.log(`[diag] reportError ctx=${context ?? '?'}: ${String(error).slice(0, 200)}`);
  try {
    if (!reportingEnabled()) return;
    const { message, stack } = toMessageAndStack(error);
    const now = Date.now();
    const report: ErrorReport = {
      fingerprint: fingerprintError(message, stack),
      message,
      ...(stack !== undefined ? { stack } : {}),
      ...(options?.componentStack !== undefined ? { componentStack: options.componentStack } : {}),
      isFatal: options?.isFatal === true,
      ...(context !== undefined || options?.context !== undefined
        ? { context: context ?? options?.context }
        : {}),
      breadcrumbs: [...breadcrumbs],
      firstSeenAt: now,
      lastSeenAt: now,
      count: 1,
      environment: buildEnvironment(),
    };
    if (doc) {
      doc.queue = mergeReport(doc.queue, report);
      // Synchronous persist: a fatal error may kill the process right after.
      persistDoc();
    } else {
      preloadCaptures.push(report);
      void loadDoc().catch(() => undefined);
    }
    // Fire-and-forget delivery attempt (no-ops offline; queue survives).
    void flushErrorQueue().catch(() => undefined);
  } catch {
    // The reporter must never take the app down with it.
  }
}

// --- delivery -------------------------------------------------------------------

let flushing = false;
let promptedThisLaunch = false;

/**
 * Try to deliver queued reports to GitHub. Existing open issues (matched by
 * the fingerprint marker in the title) get a "seen again" comment instead of
 * a duplicate issue. Without a token, asks the user (once per launch) to open
 * a pre-filled issue URL instead. Failures leave the queue untouched.
 */
export async function flushErrorQueue(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    if (!reportingEnabled()) return;
    const current = await loadDoc();
    if (current.queue.length === 0) return;

    const token = reportToken();
    if (token === undefined) {
      promptManualReport(current);
      return;
    }

    for (const report of [...current.queue]) {
      const now = Date.now();
      if (!canSendReport(current.sentHistory, now)) break;
      try {
        const marker = errorMarker(report.fingerprint);
        const existing = await findOpenIssueByMarker(token, ERROR_REPORT_REPO, marker);
        if (existing !== null) {
          await addIssueComment(token, ERROR_REPORT_REPO, existing, buildSeenAgainComment(report));
        } else {
          await createIssue(
            token,
            ERROR_REPORT_REPO,
            buildIssueTitle(report),
            buildIssueBody(report),
          );
        }
        current.queue = current.queue.filter((r) => r.fingerprint !== report.fingerprint);
        current.sentHistory = [...pruneSentHistory(current.sentHistory, now), now];
        persistDoc();
      } catch {
        // Offline or API failure — keep the queue and retry on the next flush.
        break;
      }
    }
  } finally {
    flushing = false;
  }
}

function promptManualReport(current: ErrorQueueDoc): void {
  if (promptedThisLaunch) return;
  const newest = current.queue.at(-1);
  if (newest === undefined) return;
  if (!canSendReport(current.sentHistory, Date.now())) return;
  promptedThisLaunch = true;
  useErrorPromptStore.getState().show({
    url: buildManualReportUrl(ERROR_REPORT_REPO, newest),
    fingerprint: newest.fingerprint,
    queuedCount: current.queue.length,
  });
}

/** Called by the manual-report dialog once the prefilled URL has been opened. */
export function markManualReportSent(fingerprint: string): void {
  if (!doc) return;
  const now = Date.now();
  doc.queue = doc.queue.filter((r) => r.fingerprint !== fingerprint);
  doc.sentHistory = [...pruneSentHistory(doc.sentHistory, now), now];
  persistDoc();
}

/** Called by the manual-report dialog's "Don't report" action. */
export function discardQueuedReports(): void {
  if (!doc) return;
  doc.queue = [];
  persistDoc();
}

// --- global handler installation ---------------------------------------------

let installed = false;

/**
 * Install the global capture hooks: the fatal/non-fatal JS error handler
 * (chained to the previous one) and Hermes' unhandled-promise-rejection
 * tracker. Also kicks off the launch flush and re-flushes whenever the app
 * returns to the foreground (our stand-in for "connectivity returned").
 * Idempotent.
 */
export function installErrorReporting(): void {
  if (installed) return;
  installed = true;

  const errorUtils = global.ErrorUtils;
  if (errorUtils) {
    const previous = errorUtils.getGlobalHandler();
    errorUtils.setGlobalHandler((error: unknown, isFatal?: boolean) => {
      reportError(error, isFatal === true ? 'fatal' : 'global', { isFatal: isFatal === true });
      previous(error, isFatal);
    });
  }

  // Hermes exposes its own rejection tracker (RN's Promise polyfill is not
  // used under Hermes). On other engines this is simply unavailable.
  global.HermesInternal?.enablePromiseRejectionTracker?.({
    allRejections: true,
    onUnhandled: (_id, rejection) => {
      reportError(rejection, 'unhandled-rejection');
    },
  });

  AppState.addEventListener('change', (state) => {
    if (state === 'active') void flushErrorQueue().catch(() => undefined);
  });

  // Deferred launch flush: the queue read + delivery attempt can wait until
  // well after first interaction — doing it during startup competes with the
  // initial render/navigation on slow devices (it tipped cold CI emulators
  // into dropping the first tab tap, the 2026-07-14 e2e flake).
  setTimeout(() => void flushErrorQueue().catch(() => undefined), 8000);
}
