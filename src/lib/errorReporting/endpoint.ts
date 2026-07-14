import { buildReportPayload } from '@core/errors/issueFormat';
import type { ErrorReport } from '@core/errors/types';

/**
 * Optional relay channel: POST the report to a server you control
 * (`extra.errorReportEndpoint`) instead of talking to the GitHub API from the
 * device. The relay holds the GitHub token server-side, so no credential is
 * baked into the shipped binary at all — see docs/DEPLOYMENT.md.
 *
 * Off unless the extra is set. The wire format is
 * {@link import('@core/errors/issueFormat').ErrorReportPayload} as JSON: the
 * relay can either forward `title`/`body`/`comment` verbatim to the Issues API
 * (deduping on `marker`) or reformat the raw `report` however it likes.
 */

const REQUEST_TIMEOUT_MS = 15_000;

/** An HTTP-level failure from the relay endpoint, carrying the status. */
export class EndpointError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'EndpointError';
  }
}

/**
 * Retry only what can succeed on a retry: transport failures (no status) plus
 * 408/429/5xx. A 4xx from the relay means it rejected the payload or our
 * credentials — the same bytes will be rejected again.
 */
export function isTransientEndpointFailure(error: unknown): boolean {
  if (!(error instanceof EndpointError)) return true;
  const { status } = error;
  return status === 408 || status === 429 || status >= 500;
}

/** True when the relay rejected the report itself (never retryable). */
export function isEndpointPayloadRejection(error: unknown): boolean {
  return error instanceof EndpointError && error.status === 400;
}

/** Deliver one report to the relay. Resolves on 2xx; throws otherwise. */
export async function postReportToEndpoint(endpoint: string, report: ErrorReport): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(buildReportPayload(report)),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new EndpointError(response.status, `Error-report endpoint failed: ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
