import { errorMarker, fingerprintError } from '@core/errors/fingerprint';
import { buildIssueBody, buildIssueTitle, buildSeenAgainComment } from '@core/errors/issueFormat';
import {
  backoffDelayMs,
  canSendReport,
  emptyQueueDoc,
  mergeReport,
  pruneSentHistory,
} from '@core/errors/queue';
import type { ErrorEnvironment, ErrorQueueDoc, ErrorReport } from '@core/errors/types';
import { readErrorQueueDoc, writeErrorQueueDoc } from '@data/errorQueue';
import { useSettingsStore } from '@state/settingsStore';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { AppState, Platform } from 'react-native';
import type { ErrorUtils as ErrorUtilsType } from 'react-native';
import {
  EndpointError,
  isEndpointPayloadRejection,
  isTransientEndpointFailure,
  postReportToEndpoint,
} from './endpoint';
import {
  addIssueComment,
  createIssue,
  findOpenIssueByMarker,
  isPayloadRejection,
  isTransientFailure,
} from './github';

/**
 * "No silent fails": the runtime half of the error-reporting pipeline.
 *
 * Capture (global JS handler, unhandled rejections, error boundary, explicit
 * `reportError` calls) → durable on-disk queue (errors on an offline hike must
 * survive restarts) → automatic delivery, deduped by fingerprint and
 * rate-limited client-side.
 *
 * **The reporter never talks to the user.** It files reports in the background
 * or it doesn't; it never shows a dialog, a banner, or a "go open a GitHub
 * issue" prompt. With no delivery channel configured (local dev, forks) the
 * queue simply waits on disk — silently — until a build that has one flushes it.
 * The only user-visible surfaces are the Settings opt-out toggle and the
 * (developer-facing, non-blocking) queue diagnostics next to it.
 *
 * Two delivery channels, in priority order:
 *  1. `extra.errorReportEndpoint` — POST to a relay that holds the GitHub token
 *     server-side (nothing secret in the binary).
 *  2. `extra.errorReportToken` — a fine-grained, Issues-only PAT talking to the
 *     GitHub API straight from the device.
 *
 * There is no connectivity listener on purpose (no netinfo native dependency —
 * this feature must stay OTA-able): the queue is flushed on launch, whenever
 * the app returns to the foreground, and after each capture; a flush that fails
 * offline leaves the queue alone and backs off exponentially.
 */

/** Issues repo receiving the reports. */
export const ERROR_REPORT_REPO = 'MVXTechnologies/inukshuk';

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

function extraString(key: 'errorReportToken' | 'errorReportEndpoint'): string | undefined {
  const value: unknown = Constants.expoConfig?.extra?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** How queued reports get delivered in this build, if at all. */
export type DeliveryChannel =
  { kind: 'endpoint'; endpoint: string } | { kind: 'github'; token: string } | { kind: 'none' };

/** The relay endpoint wins when both are configured (no secret in the binary). */
export function deliveryChannel(): DeliveryChannel {
  const endpoint = extraString('errorReportEndpoint');
  if (endpoint !== undefined) return { kind: 'endpoint', endpoint };
  const token = extraString('errorReportToken');
  if (token !== undefined) return { kind: 'github', token };
  return { kind: 'none' };
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
/** Consecutive transient delivery failures; drives the exponential backoff. */
let consecutiveFailures = 0;
/** Wall time before which no delivery attempt is made (0 = attempt now). */
let nextAttemptAt = 0;
/** Last delivery failure, surfaced only in the Settings diagnostics row. */
let lastFailure: string | null = null;

/** Why a flush did (or didn't) deliver — for the Settings diagnostics only. */
export type FlushStatus =
  | 'empty' // nothing queued
  | 'delivered' // at least one report filed
  | 'disabled' // user opted out
  | 'no-channel' // no token/endpoint in this build: stay queued, silently
  | 'rate-limited' // client-side cap reached for the rolling day
  | 'backoff' // a recent failure; waiting out the backoff
  | 'failed'; // attempted and failed (offline, API error)

export interface FlushResult {
  status: FlushStatus;
  /** Reports filed during this flush. */
  delivered: number;
  /** Reports discarded as permanently undeliverable (payload rejected). */
  dropped: number;
  /** Reports still waiting on disk afterwards. */
  queued: number;
}

/** One report → one issue (or one "seen again" comment). Throws on failure. */
async function deliverReport(channel: DeliveryChannel, report: ErrorReport): Promise<void> {
  if (channel.kind === 'endpoint') {
    await postReportToEndpoint(channel.endpoint, report);
    return;
  }
  if (channel.kind === 'github') {
    const { token } = channel;
    const marker = errorMarker(report.fingerprint);
    const existing = await findOpenIssueByMarker(token, ERROR_REPORT_REPO, marker);
    if (existing !== null) {
      await addIssueComment(token, ERROR_REPORT_REPO, existing, buildSeenAgainComment(report));
    } else {
      await createIssue(token, ERROR_REPORT_REPO, buildIssueTitle(report), buildIssueBody(report));
    }
  }
}

function isTransient(channel: DeliveryChannel, error: unknown): boolean {
  return channel.kind === 'endpoint'
    ? isTransientEndpointFailure(error)
    : isTransientFailure(error);
}

function isUndeliverable(channel: DeliveryChannel, error: unknown): boolean {
  return channel.kind === 'endpoint'
    ? isEndpointPayloadRejection(error)
    : isPayloadRejection(error);
}

function failureMessage(error: unknown): string {
  if (error instanceof EndpointError) return `relay HTTP ${error.status}`;
  if (error instanceof Error) return error.message.slice(0, 120);
  return String(error).slice(0, 120);
}

/** Remove a delivered/undeliverable report from the queue and persist. */
function dequeue(current: ErrorQueueDoc, fingerprint: string): void {
  current.queue = current.queue.filter((r) => r.fingerprint !== fingerprint);
  persistDoc();
}

/**
 * Try to deliver every queued report, oldest first. Repeat occurrences of a
 * fingerprint that already has an open issue become a "seen again" comment
 * instead of a duplicate issue.
 *
 * Failure handling:
 *  - transient (offline, 5xx, 429, timeout) → stop, keep the queue, and back
 *    off exponentially (30 s → 1 h) so a long offline hike doesn't retry hot;
 *  - auth/config (401/403/404) → same backoff, since retrying can't help until
 *    the build is fixed;
 *  - payload rejected (422/400) → drop *that* report so it can't sit at the
 *    head of the queue as a poison pill, and continue with the next one.
 *
 * Never throws, never renders anything. `force` (the Settings "Send now" row)
 * only bypasses the backoff — never the rate limit or the opt-out.
 */
export async function flushErrorQueue(options?: { force?: boolean }): Promise<FlushResult> {
  const force = options?.force === true;
  if (flushing) {
    const queued = doc?.queue.length ?? 0;
    return { status: queued > 0 ? 'backoff' : 'empty', delivered: 0, dropped: 0, queued };
  }
  flushing = true;
  let delivered = 0;
  let dropped = 0;
  try {
    if (!reportingEnabled()) {
      return { status: 'disabled', delivered, dropped, queued: doc?.queue.length ?? 0 };
    }
    const current = await loadDoc();
    if (current.queue.length === 0) return { status: 'empty', delivered, dropped, queued: 0 };

    const channel = deliveryChannel();
    if (channel.kind === 'none') {
      // No way to file anything in this build. Stay queued — silently. The user
      // is NEVER asked to report an error themselves.
      return { status: 'no-channel', delivered, dropped, queued: current.queue.length };
    }

    if (!force && Date.now() < nextAttemptAt) {
      return { status: 'backoff', delivered, dropped, queued: current.queue.length };
    }

    let rateLimited = false;
    let failed = false;

    for (const report of [...current.queue]) {
      const now = Date.now();
      if (!canSendReport(current.sentHistory, now)) {
        rateLimited = true;
        break;
      }
      try {
        await deliverReport(channel, report);
        dequeue(current, report.fingerprint);
        current.sentHistory = [...pruneSentHistory(current.sentHistory, now), now];
        persistDoc();
        delivered += 1;
        consecutiveFailures = 0;
        nextAttemptAt = 0;
        lastFailure = null;
      } catch (error) {
        if (isUndeliverable(channel, error)) {
          // The payload itself is unacceptable — dropping it unblocks the queue.
          dequeue(current, report.fingerprint);
          dropped += 1;
          lastFailure = failureMessage(error);
          continue;
        }
        failed = true;
        lastFailure = failureMessage(error);
        if (isTransient(channel, error)) {
          consecutiveFailures += 1;
        } else {
          // Auth/config problem: retrying is hopeless until the build changes,
          // so jump straight to the long end of the backoff.
          consecutiveFailures = Math.max(consecutiveFailures + 1, 8);
        }
        nextAttemptAt = Date.now() + backoffDelayMs(consecutiveFailures);
        break;
      }
    }

    const queued = current.queue.length;
    if (delivered > 0) return { status: 'delivered', delivered, dropped, queued };
    if (failed) return { status: 'failed', delivered, dropped, queued };
    if (rateLimited) return { status: 'rate-limited', delivered, dropped, queued };
    return { status: queued > 0 ? 'backoff' : 'empty', delivered, dropped, queued };
  } catch (error) {
    // The reporter must never take the app down with it.
    lastFailure = failureMessage(error);
    return { status: 'failed', delivered, dropped, queued: doc?.queue.length ?? 0 };
  } finally {
    flushing = false;
  }
}

/** Snapshot for the Settings diagnostics row (developer-facing, non-blocking). */
export interface ErrorQueueStatus {
  queued: number;
  /** Deliveries in the current rolling 24 h window (the rate-limit budget). */
  sentToday: number;
  /** Can this build deliver at all? */
  channel: DeliveryChannel['kind'];
  /** Last delivery failure message, if any. */
  lastFailure: string | null;
}

export async function getErrorQueueStatus(): Promise<ErrorQueueStatus> {
  let queued = 0;
  let sentToday = 0;
  try {
    const current = await loadDoc();
    queued = current.queue.length;
    sentToday = pruneSentHistory(current.sentHistory, Date.now()).length;
  } catch {
    // Unreadable queue — report it as empty rather than failing the screen.
  }
  return { queued, sentToday, channel: deliveryChannel().kind, lastFailure };
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
