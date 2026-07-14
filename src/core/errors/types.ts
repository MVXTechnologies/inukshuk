/**
 * Shared types for the error-reporting pipeline (capture → durable queue →
 * GitHub issue). Pure data shapes only — the platform glue lives in
 * `src/lib/errorReporting` and `src/data/errorQueue`.
 */

/** Environment snapshot attached to every report (captured at error time). */
export interface ErrorEnvironment {
  /** App binary version, e.g. `1.0.5`. */
  appVersion: string;
  /** expo-updates runtime version, when available. */
  runtimeVersion?: string;
  /** expo-updates OTA update id, when the JS came from an OTA update. */
  updateId?: string;
  /** OS name + version, e.g. `android 16`. */
  os: string;
  /** Device model when known, e.g. `SM-S938B`. */
  model?: string;
}

/** One captured error, deduped by fingerprint while it waits in the queue. */
export interface ErrorReport {
  /** Stable hash of the normalized message + top stack frames. */
  fingerprint: string;
  message: string;
  stack?: string;
  /** React component stack (render errors caught by the error boundary). */
  componentStack?: string;
  /** True when the error crashed the app (fatal JS error / render crash). */
  isFatal: boolean;
  /** Where the error was captured, e.g. `gpx-import`, `unhandled-rejection`. */
  context?: string;
  /** Most recent breadcrumbs at capture time, oldest first. */
  breadcrumbs: string[];
  /** First-seen wall time (ms since epoch). */
  firstSeenAt: number;
  /** Last-seen wall time (ms since epoch). */
  lastSeenAt: number;
  /** How many times this fingerprint has been seen since first queued. */
  count: number;
  environment: ErrorEnvironment;
}

/** The persisted `error-reports.json` document. */
export interface ErrorQueueDoc {
  schemaVersion: number;
  /** Reports waiting to be delivered, oldest first. */
  queue: ErrorReport[];
  /** Wall times (ms) of successfully delivered reports, for rate limiting. */
  sentHistory: number[];
}
