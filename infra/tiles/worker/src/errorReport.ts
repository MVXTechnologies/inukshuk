/**
 * Error-report relay: `POST /error-report` files the app's crash reports as
 * GitHub issues with a token that lives HERE (`wrangler secret put
 * ERROR_REPORT_GITHUB_TOKEN`), so no GitHub credential ships in the app.
 *
 * Before this, the app's `extra.errorReportToken` — a fine-grained PAT with
 * Issues read/write — was in every binary and every OTA manifest, i.e.
 * public: anyone could post, edit, close or relabel issues in the repository
 * as the token's owner. The relay can only do two things, both shaped by us:
 *
 * - create an issue whose title starts with the report's marker
 *   `[auto-report:<8 hex>]`, or
 * - add a "Seen again (…)" comment to the OPEN issue carrying that marker.
 *
 * Wire format: the app's `ErrorReportPayload` (src/core/errors/issueFormat.ts)
 * as JSON; only `fingerprint`, `marker`, `title`, `body` and `comment` are
 * read. The app has already scrubbed paths, quoted text and coordinates
 * (src/core/errors/scrub.ts) — the relay re-checks shapes and sizes, not
 * content. Answers: 202 filed, 400 malformed (the app drops the report), 429
 * limited / 5xx upstream (the app retries with backoff), 404 not configured.
 *
 * Pure, with its platform pieces injected, so the app's Jest tests it
 * (`errorReport.test.ts`).
 */

/** Issue body cap, as ISSUE_BODY_MAX in src/core/errors/issueFormat.ts (GitHub's limit is 65,536). */
export const MAX_ISSUE_BODY = 60_000;
/** Request body cap: the payload carries the body plus the raw report (roughly twice). */
export const MAX_REQUEST_BYTES = 160_000;
const MAX_TITLE = 160;
const MAX_COMMENT = 300;
/** How many newest open issues to scan for the marker (the app's own client used 100). */
const DEDUPE_SCAN = 100;

export interface ReportPayload {
  fingerprint: string;
  marker: string;
  title: string;
  body: string;
  comment: string;
}

export interface GitHubIssueSummary {
  number: number;
  title: string;
}

export interface ErrorReportDeps {
  /** Per-client rate limit (IP), true = allowed. */
  allowClient(client: string): Promise<boolean>;
  /** Budget of NEW issues (all clients together), true = allowed. Comments don't count. */
  allowNewIssue(): Promise<boolean>;
  listOpenIssues(perPage: number): Promise<GitHubIssueSummary[]>;
  createIssue(title: string, body: string): Promise<void>;
  comment(issue: number, body: string): Promise<void>;
}

export interface ErrorReportResult {
  status: number;
  body: Record<string, unknown>;
}

const bad = (error: string): ErrorReportResult => ({ status: 400, body: { ok: false, error } });

/** Control characters other than tab/newline have no place in an issue. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const CONTROL_ALL = new RegExp(CONTROL.source, 'g');

/** The payload, or the 400 message explaining why not. */
export function parsePayload(text: string): ReportPayload | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return 'body must be JSON';
  }
  if (typeof raw !== 'object' || raw === null) return 'body must be an object';
  const p = raw as Record<string, unknown>;
  const { fingerprint, marker, title, body, comment } = p;
  if (typeof fingerprint !== 'string' || !/^[0-9a-f]{8}$/.test(fingerprint)) {
    return 'bad fingerprint';
  }
  if (marker !== `[auto-report:${fingerprint}]`) return 'bad marker';
  if (typeof title !== 'string' || !title.startsWith(`${marker} `) || title.length > MAX_TITLE) {
    return 'bad title';
  }
  if (title.includes('\n')) return 'bad title';
  if (typeof body !== 'string' || body.length === 0 || body.length > MAX_ISSUE_BODY) {
    return 'bad body';
  }
  if (
    typeof comment !== 'string' ||
    !comment.startsWith('Seen again (') ||
    comment.length > MAX_COMMENT ||
    comment.includes('\n') ||
    CONTROL.test(comment)
  ) {
    return 'bad comment';
  }
  // Stray control characters (from an error message) are dropped, not fatal:
  // the report is still worth filing.
  return {
    fingerprint,
    marker,
    title: title.replace(CONTROL_ALL, ''),
    body: body.replace(CONTROL_ALL, ''),
    comment,
  };
}

export async function handleErrorReport(
  req: { method: string; client: string; body: string | null },
  deps: ErrorReportDeps,
): Promise<ErrorReportResult> {
  if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'use POST' } };
  if (req.body === null) return bad('body too large');
  if (!(await deps.allowClient(req.client))) {
    return { status: 429, body: { ok: false, error: 'try again later' } };
  }
  const payload = parsePayload(req.body);
  if (typeof payload === 'string') return bad(payload);

  const open = await deps.listOpenIssues(DEDUPE_SCAN);
  const existing = open.find((i) => i.title.includes(payload.marker));
  if (existing !== undefined) {
    await deps.comment(existing.number, payload.comment);
    return { status: 202, body: { ok: true, issue: existing.number, seenAgain: true } };
  }
  if (!(await deps.allowNewIssue())) {
    return { status: 429, body: { ok: false, error: 'try again later' } };
  }
  await deps.createIssue(payload.title, payload.body);
  return { status: 202, body: { ok: true } };
}

/** A GitHub API failure, with the status the app should see. */
export class GitHubError extends Error {
  constructor(readonly status: number) {
    super(`GitHub ${status}`);
  }
}

/**
 * The three GitHub calls, over `fetchFn`. `repo` is `owner/name`. Errors
 * become a GitHubError whose status the relay passes on as 502 (retry later)
 * or 503 for GitHub's rate limits.
 */
export function githubIssues(
  fetchFn: (url: string, init: RequestInit) => Promise<Response>,
  token: string,
  repo: string,
): Pick<ErrorReportDeps, 'listOpenIssues' | 'createIssue' | 'comment'> {
  const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await fetchFn(`https://api.github.com/repos/${repo}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'inukshuk-error-relay',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!res.ok) throw new GitHubError(res.status);
    return (await res.json()) as unknown;
  };
  return {
    listOpenIssues: async (perPage) => {
      const list = await call(`/issues?state=open&per_page=${perPage}&sort=created&direction=desc`);
      if (!Array.isArray(list)) return [];
      return list.flatMap((i: unknown) => {
        const issue = i as Partial<GitHubIssueSummary>;
        return typeof issue.number === 'number' && typeof issue.title === 'string'
          ? [{ number: issue.number, title: issue.title }]
          : [];
      });
    },
    createIssue: async (title, body) => {
      await call('/issues', { method: 'POST', body: { title, body } });
    },
    comment: async (issue, body) => {
      await call(`/issues/${issue}/comments`, { method: 'POST', body: { body } });
    },
  };
}

/** Status for the app when GitHub failed: 503 (retry later) for its limits, else 502. */
export function upstreamStatus(e: unknown): number {
  return e instanceof GitHubError && (e.status === 403 || e.status === 429) ? 503 : 502;
}
