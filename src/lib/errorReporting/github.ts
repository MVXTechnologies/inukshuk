/**
 * Minimal GitHub Issues REST client for the error reporter. Only the three
 * calls the reporter needs: find an existing auto-report issue by its
 * fingerprint marker, create an issue, and comment on one.
 *
 * Auth: a fine-grained PAT with Issues read/write on the single target repo,
 * injected at build time via `ERROR_REPORT_TOKEN` (see app.config.ts).
 */

const API_BASE = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 15_000;

/** How many open issues to scan for the dedupe marker (newest first). */
const DEDUPE_SCAN_LIMIT = 100;

interface IssueSummary {
  number: number;
  title: string;
}

/** An HTTP-level failure from the GitHub API, carrying the status for triage. */
export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

/**
 * Is this failure worth retrying with the same payload?
 *
 * - No status (network down, DNS, timeout/abort) → transient, retry later.
 * - 408 / 429 / 5xx → transient (server hiccup or secondary rate limit).
 * - 401 / 403 / 404 → the token is missing/expired/wrong-scope, or the repo is
 *   gone: retrying can only fail. Not transient — back off hard.
 * - 422 → the payload itself is unacceptable (e.g. an oversized body). Retrying
 *   the same bytes is pointless; the report is dropped rather than left as a
 *   poison pill at the head of the queue.
 */
export function isTransientFailure(error: unknown): boolean {
  if (!(error instanceof GitHubApiError)) return true;
  const { status } = error;
  return status === 408 || status === 429 || status >= 500;
}

/** True when the report itself is unacceptable and will never be accepted. */
export function isPayloadRejection(error: unknown): boolean {
  return error instanceof GitHubApiError && error.status === 422;
}

async function githubFetch(
  token: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new GitHubApiError(
        response.status,
        `GitHub API ${init?.method ?? 'GET'} ${path} failed: ${response.status}`,
      );
    }
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Find the open issue whose title carries `marker`, or null. Scans the newest
 * {@link DEDUPE_SCAN_LIMIT} open issues — plenty for a single-app repo, and it
 * avoids the separate rate-limit bucket and quoting quirks of the search API.
 */
export async function findOpenIssueByMarker(
  token: string,
  repo: string,
  marker: string,
): Promise<number | null> {
  const result = await githubFetch(
    token,
    `/repos/${repo}/issues?state=open&per_page=${DEDUPE_SCAN_LIMIT}&sort=created&direction=desc`,
  );
  if (!Array.isArray(result)) return null;
  for (const item of result) {
    const issue = item as Partial<IssueSummary>;
    if (typeof issue.number === 'number' && typeof issue.title === 'string') {
      if (issue.title.includes(marker)) return issue.number;
    }
  }
  return null;
}

/** Create an issue; returns its number. */
export async function createIssue(
  token: string,
  repo: string,
  title: string,
  body: string,
): Promise<number> {
  const result = (await githubFetch(token, `/repos/${repo}/issues`, {
    method: 'POST',
    body: { title, body },
  })) as Partial<IssueSummary>;
  if (typeof result.number !== 'number') throw new Error('GitHub API: no issue number returned');
  return result.number;
}

/** Add a comment to an existing issue. */
export async function addIssueComment(
  token: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  await githubFetch(token, `/repos/${repo}/issues/${issueNumber}/comments`, {
    method: 'POST',
    body: { body },
  });
}
